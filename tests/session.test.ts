import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent, AgentBusyError } from "../src/agent.ts";
import { DEFAULT_AGENT_CONFIG } from "../src/config.ts";
import type { ContextStrategy, HistoryRepository } from "../src/history.ts";
import { JsonProfilesRepository } from "../src/json-profiles-repository.ts";
import type { LlmCompletion } from "../src/llm-client.ts";
import { LONG_TERM_MEMORY_TITLE, WORKING_MEMORY_TITLE } from "../src/memory.ts";
import { PROFILE_INSTRUCTION, PROFILE_TITLE, ProfileError, type UserProfile } from "../src/profile.ts";
import { type AgentFactory, AgentSession, jsonAgentRepositories, userDirectory } from "../src/session.ts";
import { completionResponse, type FakeReply, fakeClient } from "./support/fake-client.ts";

const maks: UserProfile = { style: "На ты, списком", constraints: "Без эмодзи", context: "Backend-разработчик" };
const vladimir: UserProfile = { style: "На вы, таблицей", context: "Начинающий разработчик" };

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "agent-session-"));
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

interface SetupOptions {
  strategy?: ContextStrategy;
  replies?: Array<FakeReply | Error>;
}

function setup({ strategy = "sliding", replies }: SetupOptions = {}) {
  const fake = fakeClient(replies ?? Array.from({ length: 20 }, () => ({ totalTokens: 5 })));
  const createAgent = vi.fn<AgentFactory>(
    (userId, profileProvider) =>
      new Agent({
        client: fake.client,
        config: { ...DEFAULT_AGENT_CONFIG, contextStrategy: strategy },
        ...jsonAgentRepositories(directory, userId, strategy),
        ...(profileProvider === undefined ? {} : { profileProvider }),
      }),
  );
  const profilesRepository = new JsonProfilesRepository(join(directory, ".agent-profiles.json"));
  const save = vi.spyOn(profilesRepository, "save");
  const session = new AgentSession({ profilesRepository, createAgent });
  return { ...fake, session, createAgent, save };
}

function profileBlock(profile: UserProfile) {
  return { role: "user", content: `${PROFILE_TITLE}\n${JSON.stringify(profile)}` };
}

function readProfiles(): unknown {
  return JSON.parse(readFileSync(join(directory, ".agent-profiles.json"), "utf8"));
}

function errorOf(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    return error as Error;
  }
  throw new Error("Ожидалась ошибка.");
}

describe("profiles catalog in a session", () => {
  it("keeps two independent profiles, loads them by id without writing or switching", () => {
    const { session, save } = setup();

    session.initProfile("Макс", maks);
    session.saveProfile("Владимир", vladimir);
    const before = readFileSync(join(directory, ".agent-profiles.json"), "utf8");

    expect(session.loadProfile("Макс")).toEqual(maks);
    expect(session.loadProfile("Владимир")).toEqual(vladimir);
    expect(session.loadProfile("макс")).toBeNull();
    expect(session.loadProfile("Никто")).toBeNull();
    expect(session.loadProfile("constructor")).toBeNull();
    expect(session.getActiveUserId()).toBe("Макс");
    expect(save).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(directory, ".agent-profiles.json"), "utf8")).toBe(before);
    expect(readProfiles()).toEqual({ activeUserId: "Макс", profiles: { Макс: maks, Владимир: vladimir } });
  });

  it("trims identifiers and values, orders groups and keeps empty profiles and constructor", () => {
    const { session } = setup();

    session.initProfile("  Макс \t", { context: "  Backend  ", style: " На ты " });
    session.saveProfile("constructor", {});

    expect(session.getActiveUserId()).toBe("Макс");
    expect(readProfiles()).toEqual({
      activeUserId: "Макс",
      profiles: { Макс: { style: "На ты", context: "Backend" }, constructor: {} },
    });
    expect(Object.keys(session.loadProfile("Макс")!)).toEqual(["style", "context"]);
    expect(session.loadProfile("constructor")).toEqual({});
  });

  it.each(["", "  ", "a b", "_maks", "-maks", "__proto__", "Макс.Иванов", "k".repeat(65)])(
    "rejects identifier %j before any write",
    (userId) => {
      const { session, save } = setup();
      for (const action of [
        () => session.saveProfile(userId, maks),
        () => session.initProfile(userId, maks),
        () => session.switchUser(userId),
      ]) {
        expect(errorOf(action)).toBeInstanceOf(ProfileError);
      }
      expect(save).not.toHaveBeenCalled();
      expect(existsSync(join(directory, ".agent-profiles.json"))).toBe(false);
    },
  );

  it.each([
    [{ mood: "весёлый" }, "Неизвестная группа профиля «mood»"],
    [{ style: "  " }, "Значение группы style должно быть непустой строкой."],
    [{ context: 42 }, "Значение группы context должно быть непустой строкой."],
  ])("rejects profile %j without saving", (profile, reason) => {
    const { session, save } = setup();
    expect(() => session.saveProfile("Макс", profile as UserProfile)).toThrow(reason);
    expect(() => session.initProfile("Макс", profile as UserProfile)).toThrow(ProfileError);
    expect(save).not.toHaveBeenCalled();
    expect(session.getActiveUserId()).toBeNull();
  });

  it("changes one profile without touching others and detaches passed and returned objects", () => {
    const { session, save } = setup();
    const input = { ...maks };
    session.initProfile("Макс", input);
    session.saveProfile("Владимир", vladimir);
    input.style = "изменено после сохранения";

    const returned = session.loadProfile("Макс")!;
    returned.style = "изменено в копии";
    session.setProfileField("constraints", "  Без эмодзи и таблиц ");

    expect(session.loadProfile("Макс")).toEqual({ ...maks, constraints: "Без эмодзи и таблиц" });
    expect(session.loadProfile("Владимир")).toEqual(vladimir);
    save.mock.lastCall![0].profiles.Владимир!.style = "изменено после записи";
    expect(session.loadProfile("Владимир")).toEqual(vladimir);
  });

  it("deletes and clears groups of the active user only, reporting a missing group without a write", () => {
    const { session, save } = setup();
    session.saveProfile("Владимир", vladimir);
    session.initProfile("Макс", maks);

    expect(session.deleteProfileField("constraints")).toBe(true);
    expect(session.deleteProfileField("constraints")).toBe(false);
    expect(save).toHaveBeenCalledTimes(3);
    session.clearProfile();

    expect(readProfiles()).toEqual({ activeUserId: "Макс", profiles: { Владимир: vladimir, Макс: {} } });
    expect(session.getActiveUserId()).toBe("Макс");
  });

  it("requires a selected user for profile edits and suggests /profile-init", () => {
    const { session, save } = setup();
    for (const action of [
      () => session.setProfileField("style", "кратко"),
      () => session.deleteProfileField("style"),
      () => session.clearProfile(),
    ]) {
      expect(action).toThrow("Пользователь не выбран. Запустите /profile-init.");
    }
    expect(() => session.switchUser("Макс")).toThrow("Профиль «Макс» не найден. Создайте его командой /profile-init.");
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps the previous catalog, user and agent when saving fails", async () => {
    const { session, save, calls } = setup();
    session.initProfile("Макс", maks);
    await session.respond("первый");
    const before = readFileSync(join(directory, ".agent-profiles.json"), "utf8");

    for (const action of [
      () => session.setProfileField("style", "другое"),
      () => session.clearProfile(),
      () => session.saveProfile("Владимир", vladimir),
      () => session.initProfile("Владимир", vladimir),
    ]) {
      save.mockImplementationOnce((state) => {
        state.activeUserId = null;
        throw new Error("disk");
      });
      expect(action).toThrow("disk");
    }
    session.saveProfile("Владимир", vladimir);
    save.mockImplementationOnce(() => {
      throw new Error("disk");
    });
    expect(() => session.switchUser("Владимир")).toThrow("disk");

    expect(session.getActiveUserId()).toBe("Макс");
    expect(session.loadProfile("Макс")).toEqual(maks);
    expect(JSON.parse(before)).toEqual({ activeUserId: "Макс", profiles: { Макс: maks } });
    const result = await session.respond("второй");
    expect(result.usage.session.totalTokens).toBe(10);
    expect(calls[1]!.messages.slice(1)).toEqual([
      profileBlock(maks),
      { role: "user", content: "первый" },
      { role: "assistant", content: "ответ" },
      { role: "user", content: "второй" },
    ]);
  });
});

describe("user selection", () => {
  it("restores the last selected user and his dialog after a restart without loading the legacy dialog", async () => {
    const legacy = join(directory, ".agent-history.sliding.json");
    const first = setup();
    first.session.initProfile("Макс", maks);
    await first.session.respond("Код Макса — КЕДР");
    writeFileSync(legacy, "{");

    const second = setup({ replies: [{ totalTokens: 3 }] });
    expect(second.createAgent.mock.calls.map(([userId]) => userId)).toEqual(["Макс"]);
    expect(second.session.getActiveUserId()).toBe("Макс");
    const result = await second.session.respond("вопрос");

    expect(result.usage.session.totalTokens).toBe(3);
    expect(second.calls[0]!.messages).toEqual([
      { role: "system", content: `${DEFAULT_AGENT_CONFIG.systemPrompt}\n\n${PROFILE_INSTRUCTION}` },
      profileBlock(maks),
      { role: "user", content: "Код Макса — КЕДР" },
      { role: "assistant", content: "ответ" },
      { role: "user", content: "вопрос" },
    ]);
    expect(readFileSync(legacy, "utf8")).toBe("{");
  });

  it.each([
    [".agent-history.sliding.json", "историю"],
    [".agent-memory.working.json", "память working"],
    [".agent-memory.long-term.json", "память long"],
  ])("does not switch when %s of the target user is corrupted", async (file, subject) => {
    const { session, save, calls } = setup();
    session.saveProfile("Владимир", vladimir);
    session.initProfile("Макс", maks);
    const target = userDirectory(directory, "Владимир");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, file), "{");
    const catalog = readFileSync(join(directory, ".agent-profiles.json"), "utf8");

    expect(() => session.switchUser("Владимир")).toThrow(`Не удалось загрузить ${subject}`);
    expect(() => session.initProfile("Владимир", { style: "новый" })).toThrow(`Не удалось загрузить ${subject}`);

    expect(save).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(directory, ".agent-profiles.json"), "utf8")).toBe(catalog);
    expect(session.getActiveUserId()).toBe("Макс");
    expect(session.loadProfile("Владимир")).toEqual(vladimir);
    await session.respond("вопрос");
    expect(calls[0]!.messages[1]).toEqual(profileBlock(maks));
    expect(readFileSync(join(target, file), "utf8")).toBe("{");
  });

  it("selecting the active user keeps the agent, the catalog file and the usage", async () => {
    const { session, save, createAgent } = setup();
    session.initProfile("Макс", maks);
    await session.respond("первый");

    session.switchUser(" Макс ");
    session.initProfile("Макс", { ...maks, style: "На ты, подробно" });

    expect(createAgent).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledTimes(2);
    const result = await session.respond("второй");
    expect(result.usage.session.totalTokens).toBe(10);
  });

  it("applies profile edits to the current agent without resetting the dialog or usage", async () => {
    const { session, calls, createAgent } = setup();
    session.initProfile("Макс", maks);
    await session.respond("первый");

    session.setProfileField("style", "На ты, одной фразой");
    session.deleteProfileField("context");
    const result = await session.respond("второй");

    expect(createAgent).toHaveBeenCalledTimes(2);
    expect(result.usage.session.totalTokens).toBe(10);
    expect(calls[1]!.messages.slice(1)).toEqual([
      profileBlock({ style: "На ты, одной фразой", constraints: "Без эмодзи" }),
      { role: "user", content: "первый" },
      { role: "assistant", content: "ответ" },
      { role: "user", content: "второй" },
    ]);
    session.clearProfile();
    await session.respond("третий");
    expect(calls[2]!.messages[0]).toEqual({ role: "system", content: DEFAULT_AGENT_CONFIG.systemPrompt });
    expect(calls[2]!.messages).toHaveLength(6);
  });

  it("starts a new usage session after switching users and back", async () => {
    const { session } = setup();
    session.saveProfile("Владимир", vladimir);
    session.initProfile("Макс", maks);
    await session.respond("первый");
    session.switchUser("Владимир");
    expect((await session.respond("второй")).usage.session.totalTokens).toBe(5);
    session.switchUser("Макс");
    expect((await session.respond("третий")).usage.session.totalTokens).toBe(5);
  });

  it("blocks switching and profile writes for the whole turn, including the history save", async () => {
    let release!: (value: LlmCompletion) => void;
    const historySave = vi.fn<HistoryRepository["save"]>();
    const profilesRepository = { load: () => null, save: vi.fn() };
    const session = new AgentSession({
      profilesRepository,
      createAgent: (_userId, profileProvider) =>
        new Agent({
          client: {
            create: () =>
              new Promise<LlmCompletion>((resolve) => {
                release = resolve;
              }),
          },
          config: { ...DEFAULT_AGENT_CONFIG, contextStrategy: "sliding" },
          historyRepository: { load: () => null, save: historySave },
          ...(profileProvider === undefined ? {} : { profileProvider }),
        }),
    });
    session.saveProfile("Владимир", vladimir);
    session.initProfile("Макс", maks);
    profilesRepository.save.mockClear();
    const expectBlocked = () => {
      for (const action of [
        () => session.switchUser("Владимир"),
        () => session.switchUser("Макс"),
        () => session.initProfile("Макс", maks),
        () => session.saveProfile("Владимир", maks),
        () => session.setProfileField("style", "другое"),
        () => session.deleteProfileField("style"),
        () => session.clearProfile(),
      ]) {
        expect(action).toThrow(AgentBusyError);
      }
      expect(session.getActiveUserId()).toBe("Макс");
      expect(session.loadProfile("Макс")).toEqual(maks);
      expect(session.getContextStatus()).toEqual({ strategy: "sliding", activeBranch: null });
    };
    historySave.mockImplementationOnce(expectBlocked);

    const pending = session.respond("вопрос");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expectBlocked();
    await expect(session.respond("параллельный")).rejects.toThrow(AgentBusyError);
    release(completionResponse({ model: "test", messages: [] }, { content: "ответ" }));
    await pending;

    expect(historySave).toHaveBeenCalledOnce();
    expect(profilesRepository.save).not.toHaveBeenCalled();
    session.switchUser("Владимир");
    expect(session.getActiveUserId()).toBe("Владимир");
  });

  it("releases the lock after a failed turn", async () => {
    const { session } = setup({ replies: [new Error("API недоступен")] });
    session.initProfile("Макс", maks);
    await expect(session.respond("вопрос")).rejects.toThrow("API недоступен");
    session.setProfileField("style", "после ошибки");
    expect(session.loadProfile("Макс")!.style).toBe("после ошибки");
  });
});

describe("per-user files", () => {
  it("stores data under the SHA-256 of the identifier and creates nothing on a plain switch", async () => {
    const { session } = setup();
    session.saveProfile("Владимир", vladimir);
    session.initProfile("Макс", maks);
    session.switchUser("Владимир");
    session.switchUser("Макс");

    const hash = createHash("sha256").update("Макс", "utf8").digest("hex");
    expect(userDirectory(directory, "Макс")).toBe(join(directory, ".agent-users", hash));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(directory, ".agent-users"))).toBe(false);

    await session.respond("вопрос");
    expect(readdirSync(join(directory, ".agent-users"))).toEqual([hash]);
    expect(readdirSync(join(directory, ".agent-users", hash))).toEqual([".agent-history.sliding.json"]);
    expect(readdirSync(directory).sort()).toEqual([".agent-profiles.json", ".agent-users"]);
  });

  it("keeps the legacy root files without a selected user and never assigns them to a new user", async () => {
    const { session, calls } = setup();
    session.setMemory("long", "transport", "поезд");
    await session.respond("общий вопрос");
    const legacy = readFileSync(join(directory, ".agent-history.sliding.json"), "utf8");

    session.initProfile("Макс", {});
    expect(session.getMemory()).toEqual({ short: { kind: "sliding", messages: [] }, working: {}, long: {} });
    await session.respond("личный вопрос");

    expect(calls[1]!.messages).toEqual([
      { role: "system", content: DEFAULT_AGENT_CONFIG.systemPrompt },
      { role: "user", content: "личный вопрос" },
    ]);
    expect(readFileSync(join(directory, ".agent-history.sliding.json"), "utf8")).toBe(legacy);
    expect(JSON.parse(readFileSync(join(directory, ".agent-memory.long-term.json"), "utf8"))).toEqual({
      transport: "поезд",
    });
  });

  it("isolates profile, dialog and both dictionaries between users and restores them on return", async () => {
    const { session, calls } = setup();
    session.initProfile("Макс", maks);
    session.setMemory("working", "task", "кеш для API");
    session.setMemory("long", "language", "TypeScript");
    await session.respond("Код Макса — КЕДР");

    session.initProfile("Владимир", vladimir);
    expect(session.getMemory()).toEqual({ short: { kind: "sliding", messages: [] }, working: {}, long: {} });
    await session.respond("Что такое кеш?");
    session.setMemory("long", "language", "Python");

    session.switchUser("Макс");
    await session.respond("Что я просил?");

    expect(calls[1]!.messages).toEqual([
      { role: "system", content: `${DEFAULT_AGENT_CONFIG.systemPrompt}\n\n${PROFILE_INSTRUCTION}` },
      profileBlock(vladimir),
      { role: "user", content: "Что такое кеш?" },
    ]);
    for (const secret of ["КЕДР", "Backend", "Без эмодзи", "TypeScript", "кеш для API"]) {
      expect(JSON.stringify(calls[1])).not.toContain(secret);
    }
    expect(calls[2]!.messages.slice(1)).toEqual([
      profileBlock(maks),
      { role: "user", content: `${LONG_TERM_MEMORY_TITLE}\n{"language":"TypeScript"}` },
      { role: "user", content: `${WORKING_MEMORY_TITLE}\n{"task":"кеш для API"}` },
      { role: "user", content: "Код Макса — КЕДР" },
      { role: "assistant", content: "ответ" },
      { role: "user", content: "Что я просил?" },
    ]);
    expect(JSON.stringify(calls[2])).not.toContain("Python");
  });

  it("isolates reset, branches, checkpoint and memory clearing between users", async () => {
    const { session } = setup({ strategy: "branching" });
    session.initProfile("Макс", maks);
    await session.respond("цель Макса");
    session.createCheckpoint();
    session.createBranch("a");
    await session.respond("вариант A");
    session.setMemory("working", "task", "Макс");

    session.initProfile("Владимир", vladimir);
    expect(session.getContextStatus()).toEqual({ strategy: "branching", activeBranch: "main" });
    expect(session.listBranches()).toEqual([{ name: "main", active: true, messageCount: 0 }]);
    expect(() => session.createBranch("b")).toThrow("Нет checkpoint");
    await session.respond("цель Владимира");
    session.setMemory("working", "task", "Владимир");
    session.clearMemory("working");
    session.reset();
    expect(session.getMemory().short).toEqual({
      kind: "branching",
      activeBranch: "main",
      branches: { main: [] },
      checkpoint: null,
    });

    session.switchUser("Макс");
    expect(session.getContextStatus()).toEqual({ strategy: "branching", activeBranch: "a" });
    expect(session.listBranches()).toEqual([
      { name: "main", active: false, messageCount: 2 },
      { name: "a", active: true, messageCount: 4 },
    ]);
    const memory = session.getMemory();
    expect(memory.working).toEqual({ task: "Макс" });
    expect(memory.short.kind === "branching" && memory.short.checkpoint).toEqual([
      { role: "user", content: "цель Макса" },
      { role: "assistant", content: "ответ" },
    ]);
    session.deleteMemory("working", "task");
    session.switchBranch("main");
    session.switchUser("Владимир");
    expect(session.getContextStatus()).toEqual({ strategy: "branching", activeBranch: "main" });
    session.switchUser("Макс");
    expect(session.getContextStatus()).toEqual({ strategy: "branching", activeBranch: "main" });
    session.switchUser("Владимир");
    expect(session.getMemory().working).toEqual({});
  });
});
