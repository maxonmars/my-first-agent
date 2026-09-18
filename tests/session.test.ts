import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent, AgentBusyError, type AgentConfig } from "../src/agent.ts";
import { DEFAULT_AGENT_CONFIG } from "../src/config.ts";
import type { ContextStrategy, HistoryRepository } from "../src/history.ts";
import type { Invariant } from "../src/invariants.ts";
import { JsonProfilesRepository } from "../src/json-profiles-repository.ts";
import type { LlmCompletion } from "../src/llm-client.ts";
import { LONG_TERM_MEMORY_TITLE, MEMORY_INSTRUCTION, WORKING_MEMORY_TITLE } from "../src/memory.ts";
import {
  type AgentProfile,
  PROFILE_INSTRUCTION,
  PROFILE_META_INSTRUCTION,
  PROFILE_TITLE,
  ProfileError,
} from "../src/profile.ts";
import { type AgentFactory, AgentSession, jsonAgentRepositories } from "../src/session.ts";
import { SUPPORT_INVARIANTS } from "../src/support-invariants.ts";
import { TASK_INSTRUCTION } from "../src/task.ts";
import { completionResponse, type FakeReply, fakeClient } from "./support/fake-client.ts";

const analyst: AgentProfile = {
  style: "Короткий бриф списком",
  constraints: "Не придумывай факты",
  context: "Ты аналитик мероприятий",
};
const author: AgentProfile = { style: "Живой текст анонса", context: "Ты автор анонсов" };
const editor: AgentProfile = { style: "Список замечаний", constraints: "Без новых фактов", context: "Ты редактор" };

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "agent-session-"));
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

interface SetupOptions {
  strategy?: ContextStrategy;
  replies?: Array<FakeReply | Error>;
  config?: Partial<AgentConfig>;
  invariants?: readonly Invariant[];
}

function setup({ strategy = "sliding", replies, config = {}, invariants }: SetupOptions = {}) {
  const fake = fakeClient(replies ?? Array.from({ length: 20 }, () => ({ totalTokens: 5 })));
  const createAgent = vi.fn<AgentFactory>(
    (profileProvider) =>
      new Agent({
        client: fake.client,
        config: { ...DEFAULT_AGENT_CONFIG, contextStrategy: strategy, ...config },
        ...jsonAgentRepositories(directory, strategy),
        profileProvider,
        ...(invariants === undefined ? {} : { invariants }),
      }),
  );
  const profilesRepository = new JsonProfilesRepository(join(directory, ".agent-profiles.json"));
  const save = vi.spyOn(profilesRepository, "save");
  const session = new AgentSession({ profilesRepository, createAgent });
  return { ...fake, session, createAgent, save };
}

function profileBlock(profile: AgentProfile) {
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

    session.initProfile("аналитик", analyst);
    session.saveProfile("автор", author);
    const before = readFileSync(join(directory, ".agent-profiles.json"), "utf8");

    expect(session.loadProfile("аналитик")).toEqual(analyst);
    expect(session.loadProfile("автор")).toEqual(author);
    expect(session.loadProfile("Аналитик")).toBeNull();
    expect(session.loadProfile("никто")).toBeNull();
    expect(session.loadProfile("constructor")).toBeNull();
    expect(session.getActiveProfileId()).toBe("аналитик");
    expect(save).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(directory, ".agent-profiles.json"), "utf8")).toBe(before);
    expect(readProfiles()).toEqual({ activeProfileId: "аналитик", profiles: { аналитик: analyst, автор: author } });
  });

  it("lists profile ids in code-point order as a detached array without writing", () => {
    const { session, save, createAgent } = setup();
    expect(session.listProfileIds()).toEqual([]);

    session.saveProfile("редактор", editor);
    session.initProfile("автор", author);
    session.saveProfile("Автор", {});
    session.saveProfile("аналитик", analyst);
    const before = readFileSync(join(directory, ".agent-profiles.json"), "utf8");

    const ids = session.listProfileIds();
    expect(ids).toEqual(["Автор", "автор", "аналитик", "редактор"]);
    (ids as string[]).push("чужой");
    (ids as string[]).length = 0;

    expect(session.listProfileIds()).toEqual(["Автор", "автор", "аналитик", "редактор"]);
    expect(session.loadProfile("чужой")).toBeNull();
    expect(session.getActiveProfileId()).toBe("автор");
    expect(save).toHaveBeenCalledTimes(4);
    expect(readFileSync(join(directory, ".agent-profiles.json"), "utf8")).toBe(before);
    expect(createAgent).toHaveBeenCalledOnce();
  });

  it("trims identifiers and values, orders groups and keeps empty profiles and constructor", () => {
    const { session } = setup();

    session.initProfile("  аналитик \t", { context: "  Backend  ", style: " На ты " });
    session.saveProfile("constructor", {});

    expect(session.getActiveProfileId()).toBe("аналитик");
    expect(readProfiles()).toEqual({
      activeProfileId: "аналитик",
      profiles: { аналитик: { style: "На ты", context: "Backend" }, constructor: {} },
    });
    expect(Object.keys(session.loadProfile("аналитик")!)).toEqual(["style", "context"]);
    expect(session.loadProfile("constructor")).toEqual({});
  });

  it.each(["", "  ", "a b", "_analyst", "-analyst", "__proto__", "аналитик.старший", "k".repeat(65)])(
    "rejects identifier %j before any write",
    (profileId) => {
      const { session, save } = setup();
      for (const action of [
        () => session.saveProfile(profileId, analyst),
        () => session.initProfile(profileId, analyst),
        () => session.switchProfile(profileId),
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
    expect(() => session.saveProfile("аналитик", profile as AgentProfile)).toThrow(reason);
    expect(() => session.initProfile("аналитик", profile as AgentProfile)).toThrow(ProfileError);
    expect(save).not.toHaveBeenCalled();
    expect(session.getActiveProfileId()).toBeNull();
  });

  it("changes one profile without touching others and detaches passed and returned objects", () => {
    const { session, save } = setup();
    const input = { ...analyst };
    session.initProfile("аналитик", input);
    session.saveProfile("автор", author);
    input.style = "изменено после сохранения";

    const returned = session.loadProfile("аналитик")!;
    returned.style = "изменено в копии";
    session.setProfileField("constraints", "  Без эмодзи и таблиц ");

    expect(session.loadProfile("аналитик")).toEqual({ ...analyst, constraints: "Без эмодзи и таблиц" });
    expect(session.loadProfile("автор")).toEqual(author);
    save.mock.lastCall![0].profiles.автор!.style = "изменено после записи";
    expect(session.loadProfile("автор")).toEqual(author);
  });

  it("deletes and clears groups of the active profile only, reporting a missing group without a write", () => {
    const { session, save } = setup();
    session.saveProfile("автор", author);
    session.initProfile("аналитик", analyst);

    expect(session.deleteProfileField("constraints")).toBe(true);
    expect(session.deleteProfileField("constraints")).toBe(false);
    expect(save).toHaveBeenCalledTimes(3);
    session.clearProfile();

    expect(readProfiles()).toEqual({ activeProfileId: "аналитик", profiles: { автор: author, аналитик: {} } });
    expect(session.getActiveProfileId()).toBe("аналитик");
  });

  it("requires a selected profile for edits and suggests /profile-init", () => {
    const { session, save } = setup();
    for (const action of [
      () => session.setProfileField("style", "кратко"),
      () => session.deleteProfileField("style"),
      () => session.clearProfile(),
    ]) {
      expect(action).toThrow("Профиль не выбран. Запустите /profile-init.");
    }
    expect(() => session.switchProfile("аналитик")).toThrow(
      "Профиль «аналитик» не найден. Создайте его командой /profile-init.",
    );
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps the previous catalog, profile and agent state when saving fails", async () => {
    const { session, save, calls } = setup();
    session.initProfile("аналитик", analyst);
    await session.respond("первый");
    const before = readFileSync(join(directory, ".agent-profiles.json"), "utf8");

    for (const action of [
      () => session.setProfileField("style", "другое"),
      () => session.clearProfile(),
      () => session.saveProfile("автор", author),
      () => session.initProfile("автор", author),
    ]) {
      save.mockImplementationOnce((state) => {
        state.activeProfileId = null;
        throw new Error("disk");
      });
      expect(action).toThrow("disk");
    }
    session.saveProfile("автор", author);
    save.mockImplementationOnce(() => {
      throw new Error("disk");
    });
    expect(() => session.switchProfile("автор")).toThrow("disk");

    expect(session.getActiveProfileId()).toBe("аналитик");
    expect(readProfiles()).toMatchObject({ activeProfileId: "аналитик" });
    expect(session.loadProfile("аналитик")).toEqual(analyst);
    expect(JSON.parse(before)).toEqual({ activeProfileId: "аналитик", profiles: { аналитик: analyst } });
    const result = await session.respond("второй");
    expect(result.usage.session.totalTokens).toBe(10);
    expect(calls[1]!.messages.slice(1)).toEqual([
      profileBlock(analyst),
      { role: "user", content: "первый" },
      { role: "assistant", content: "ответ" },
      { role: "user", content: "второй" },
    ]);
  });
});

describe("one agent with shared memory", () => {
  it("creates the agent once and sends the current profile with the shared dialog and memory", async () => {
    const { session, calls, createAgent, save } = setup();
    session.saveProfile("автор", author);
    session.initProfile("аналитик", analyst);
    session.setMemory("working", "event", "Онлайн-встреча, 40 минут");
    session.setMemory("long", "audience", "новички");
    await session.respond("Составь бриф");

    session.switchProfile("автор");
    session.switchProfile(" автор ");
    const result = await session.respond("Подготовь анонс");

    expect(createAgent).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledTimes(3);
    expect(result.usage.session.totalTokens).toBe(10);
    expect(calls[1]!.messages).toEqual([
      {
        role: "system",
        content: `${DEFAULT_AGENT_CONFIG.systemPrompt}\n\n${PROFILE_INSTRUCTION}\n\n${MEMORY_INSTRUCTION}`,
      },
      profileBlock(author),
      { role: "user", content: `${LONG_TERM_MEMORY_TITLE}\n{"audience":"новички"}` },
      { role: "user", content: `${WORKING_MEMORY_TITLE}\n{"event":"Онлайн-встреча, 40 минут"}` },
      { role: "user", content: "Составь бриф" },
      { role: "assistant", content: "ответ" },
      { role: "user", content: "Подготовь анонс" },
    ]);
    expect(JSON.stringify(calls[1])).not.toContain("аналитик мероприятий");
  });

  it("applies edits, clearing and initialization without recreating the agent or resetting usage", async () => {
    const { session, calls, createAgent } = setup();
    session.initProfile("аналитик", analyst);
    await session.respond("первый");

    session.setProfileField("style", "Одной фразой");
    session.deleteProfileField("context");
    const second = await session.respond("второй");
    session.initProfile("редактор", editor);
    session.clearProfile();
    const third = await session.respond("третий");

    expect(createAgent).toHaveBeenCalledOnce();
    expect(second.usage.session.totalTokens).toBe(10);
    expect(third.usage.session.totalTokens).toBe(15);
    expect(calls[1]!.messages[1]).toEqual(profileBlock({ style: "Одной фразой", constraints: "Не придумывай факты" }));
    expect(session.getActiveProfileId()).toBe("редактор");
    expect(calls[2]!.messages).toEqual([
      { role: "system", content: DEFAULT_AGENT_CONFIG.systemPrompt },
      { role: "user", content: "первый" },
      { role: "assistant", content: "ответ" },
      { role: "user", content: "второй" },
      { role: "assistant", content: "ответ" },
      { role: "user", content: "третий" },
    ]);
  });

  it("works without a profile as before and keeps the root files shared after selecting one", async () => {
    const { session, calls } = setup();
    session.setMemory("long", "transport", "поезд");
    await session.respond("общий вопрос");

    expect(calls[0]!.messages).toEqual([
      { role: "system", content: `${DEFAULT_AGENT_CONFIG.systemPrompt}\n\n${MEMORY_INSTRUCTION}` },
      { role: "user", content: `${LONG_TERM_MEMORY_TITLE}\n{"transport":"поезд"}` },
      { role: "user", content: "общий вопрос" },
    ]);
    session.initProfile("автор", author);
    await session.respond("продолжение");
    expect(calls[1]!.messages.slice(1)).toEqual([
      profileBlock(author),
      { role: "user", content: `${LONG_TERM_MEMORY_TITLE}\n{"transport":"поезд"}` },
      { role: "user", content: "общий вопрос" },
      { role: "assistant", content: "ответ" },
      { role: "user", content: "продолжение" },
    ]);
    expect(readdirSync(directory).sort()).toEqual([
      ".agent-history.sliding.json",
      ".agent-memory.long-term.json",
      ".agent-profiles.json",
    ]);
  });

  it.each<ContextStrategy>([null, "compression", "sliding", "facts", "branching"])(
    "%s: continues the shared history after switching the profile",
    async (strategy) => {
      const replies = strategy === "facts" ? [{ content: "{}" }, {}, { content: "{}" }, {}] : [{}, {}];
      const { session, calls } = setup({ strategy, replies });
      session.saveProfile("автор", author);
      session.initProfile("аналитик", analyst);
      await session.respond("первый");
      session.switchProfile("автор");
      await session.respond("второй");

      const final = calls.at(-1)!;
      expect(final.messages[0]!.content).toContain(PROFILE_INSTRUCTION);
      expect(final.messages[1]).toEqual(profileBlock(author));
      expect(final.messages.slice(-3)).toEqual([
        { role: "user", content: "первый" },
        { role: "assistant", content: "ответ" },
        { role: "user", content: "второй" },
      ]);
      if (strategy === "facts") expect(JSON.stringify(calls[2])).not.toContain(PROFILE_TITLE);
    },
  );

  it("keeps branches, checkpoint and both dictionaries across profile switches", async () => {
    const { session, calls } = setup({ strategy: "branching" });
    session.saveProfile("автор", author);
    session.saveProfile("редактор", editor);
    session.initProfile("аналитик", analyst);
    await session.respond("бриф");
    session.createCheckpoint();
    session.createBranch("a");
    await session.respond("вариант A");
    session.setMemory("working", "event", "встреча");
    session.setMemory("long", "tone", "дружелюбно");
    const before = session.getMemory();

    session.switchProfile("автор");
    expect(session.getMemory()).toEqual(before);
    expect(session.getContextStatus()).toEqual({ strategy: "branching", activeBranch: "a" });
    expect(session.listBranches()).toEqual([
      { name: "main", active: false, messageCount: 2 },
      { name: "a", active: true, messageCount: 4 },
    ]);
    await session.respond("анонс");
    expect(calls[2]!.messages[1]).toEqual(profileBlock(author));
    expect(calls[2]!.messages.slice(-5).map((message) => message.content)).toEqual([
      "бриф",
      "ответ",
      "вариант A",
      "ответ",
      "анонс",
    ]);

    session.switchBranch("main");
    session.switchProfile("редактор");
    expect(session.getContextStatus()).toEqual({ strategy: "branching", activeBranch: "main" });
    const memory = session.getMemory();
    expect(memory.short.kind === "branching" && memory.short.checkpoint).toEqual([
      { role: "user", content: "бриф" },
      { role: "assistant", content: "ответ" },
    ]);
    expect(memory.working).toEqual({ event: "встреча" });
    expect(memory.long).toEqual({ tone: "дружелюбно" });
  });

  it("keeps the task stage, plan, results, question and pause; meta and final share one profile snapshot", async () => {
    const json = (reply: Record<string, unknown>): FakeReply => ({ content: JSON.stringify(reply), totalTokens: 5 });
    const meta: FakeReply = { content: "Подготовленный промпт", totalTokens: 5 };
    const { session, calls, createAgent } = setup({
      config: { strategy: "meta" },
      replies: [
        meta,
        json({ action: "propose_plan", answer: "План", steps: ["Бриф", "Текст"] }),
        meta,
        json({ action: "complete_step", answer: "Бриф готов" }),
        meta,
        json({ action: "ask", answer: "Какая дата встречи?" }),
      ],
    });
    session.saveProfile("автор", author);
    session.saveProfile("редактор", editor);
    session.initProfile("аналитик", analyst);
    session.startTask("Анонс встречи");
    await session.respond("Продолжай");

    session.switchProfile("автор");
    expect(session.getTask()!.context).toMatchObject({ state: "planning", plan: ["Бриф", "Текст"] });
    session.approveTask();
    await session.respond("Продолжай");
    session.switchProfile("редактор");
    const result = await session.respond("Продолжай");
    session.pauseTask();
    session.switchProfile("аналитик");

    expect(createAgent).toHaveBeenCalledOnce();
    expect(result.usage.session.totalTokens).toBe(30);
    expect(session.getTask()!.context).toEqual({
      task: "Анонс встречи",
      state: "execution",
      paused: true,
      plan: ["Бриф", "Текст"],
      results: ["Бриф готов"],
      waitingFor: "Какая дата встречи?",
      review: null,
    });
    const [metaCall, finalCall] = calls.slice(4);
    expect(metaCall!.messages[1]).toEqual(profileBlock(editor));
    expect(finalCall!.messages.slice(1)).toEqual(metaCall!.messages.slice(1));
    expect(metaCall!.messages[0]!.content).toContain(PROFILE_META_INSTRUCTION);
    expect(finalCall!.messages[0]!.content).toContain(PROFILE_INSTRUCTION);
    expect(finalCall!.messages[0]!.content).toContain(TASK_INSTRUCTION);
    expect(calls[3]!.messages[1]).toEqual(profileBlock(author));
    expect(existsSync(join(directory, ".agent-task.json"))).toBe(true);
  });

  it("restores the selected profile and shared data after a restart with a new usage session", async () => {
    const first = setup();
    first.session.saveProfile("аналитик", analyst);
    first.session.initProfile("редактор", editor);
    first.session.setMemory("working", "event", "40 минут");
    first.session.startTask("Анонс");
    first.session.pauseTask();
    await first.session.respond("Проверь анонс");

    const second = setup({ replies: [{ totalTokens: 3 }] });
    expect(second.session.getActiveProfileId()).toBe("редактор");
    expect(second.session.getTask()!.context).toMatchObject({ task: "Анонс", paused: true });
    const result = await second.session.respond("Что проверено?");

    expect(result.usage.session.totalTokens).toBe(3);
    expect(second.calls[0]!.messages.slice(1)).toEqual([
      profileBlock(editor),
      { role: "user", content: `${WORKING_MEMORY_TITLE}\n{"event":"40 минут"}` },
      { role: "user", content: "Проверь анонс" },
      { role: "assistant", content: "ответ" },
      { role: "user", content: "Что проверено?" },
    ]);
  });

  it("blocks selecting and writing profiles for the whole turn, including the history save", async () => {
    let release!: (value: LlmCompletion) => void;
    const historySave = vi.fn<HistoryRepository["save"]>();
    const profilesRepository = { load: () => null, save: vi.fn() };
    const session = new AgentSession({
      profilesRepository,
      createAgent: (profileProvider) =>
        new Agent({
          client: {
            create: () =>
              new Promise<LlmCompletion>((resolve) => {
                release = resolve;
              }),
          },
          config: { ...DEFAULT_AGENT_CONFIG, contextStrategy: "sliding" },
          historyRepository: { load: () => null, save: historySave },
          profileProvider,
        }),
    });
    session.saveProfile("автор", author);
    session.initProfile("аналитик", analyst);
    profilesRepository.save.mockClear();
    const expectBlocked = () => {
      for (const action of [
        () => session.switchProfile("автор"),
        () => session.switchProfile("аналитик"),
        () => session.initProfile("аналитик", analyst),
        () => session.saveProfile("автор", analyst),
        () => session.setProfileField("style", "другое"),
        () => session.deleteProfileField("style"),
        () => session.clearProfile(),
      ]) {
        expect(action).toThrow(AgentBusyError);
      }
      expect(session.getActiveProfileId()).toBe("аналитик");
      expect(session.loadProfile("аналитик")).toEqual(analyst);
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
    session.switchProfile("автор");
    expect(session.getActiveProfileId()).toBe("автор");
  });

  it("releases the lock after a failed turn", async () => {
    const { session } = setup({ replies: [new Error("API недоступен")] });
    session.initProfile("аналитик", analyst);
    await expect(session.respond("вопрос")).rejects.toThrow("API недоступен");
    session.setProfileField("style", "после ошибки");
    expect(session.loadProfile("аналитик")!.style).toBe("после ошибки");
  });
});

describe("legacy user data", () => {
  it("rejects the legacy catalog without changing it or creating an agent", () => {
    const source = JSON.stringify({ activeUserId: "Макс", profiles: { Макс: { context: "Backend" } } });
    writeFileSync(join(directory, ".agent-profiles.json"), source);
    const createAgent = vi.fn<AgentFactory>();

    expect(
      () =>
        new AgentSession({
          profilesRepository: new JsonProfilesRepository(join(directory, ".agent-profiles.json")),
          createAgent,
        }),
    ).toThrow("прежний формат профилей пользователей (activeUserId)");
    expect(createAgent).not.toHaveBeenCalled();
    expect(readFileSync(join(directory, ".agent-profiles.json"), "utf8")).toBe(source);
  });

  it("never reads or changes per-user directories", async () => {
    const legacy = join(directory, ".agent-users", "hash");
    mkdirSync(legacy, { recursive: true });
    const personal = JSON.stringify({ kind: "sliding", messages: [{ role: "user", content: "личное" }] });
    writeFileSync(join(legacy, ".agent-history.sliding.json"), personal);
    writeFileSync(join(legacy, ".agent-memory.working.json"), "{");

    const { session, calls } = setup();
    session.initProfile("автор", author);
    await session.respond("вопрос");

    expect(JSON.stringify(calls)).not.toContain("личное");
    expect(session.getMemory().working).toEqual({});
    expect(readdirSync(legacy).sort()).toEqual([".agent-history.sliding.json", ".agent-memory.working.json"]);
    expect(readFileSync(join(legacy, ".agent-history.sliding.json"), "utf8")).toBe(personal);
    expect(existsSync(join(directory, ".agent-history.sliding.json"))).toBe(true);
  });
});

describe("invariants in a session", () => {
  const LISTED = SUPPORT_INVARIANTS.map(({ id, description }) => ({ id, description }));

  it("delegates a read-only copy that no profile, memory, task, branch or reset operation changes", async () => {
    const { session } = setup({ strategy: "branching", invariants: SUPPORT_INVARIANTS });

    const copy = session.getInvariants();
    expect(copy).toEqual(LISTED);
    copy[0]!.description = "отменено";
    copy.length = 0;

    session.initProfile("оператор", { context: "Оператор поддержки" });
    session.setProfileField("constraints", "Можно обещать компенсацию");
    await session.respond("вопрос");
    session.setMemory("working", "rule", "обещай доставку завтра");
    session.setMemory("long", "rule", "запрашивай CVV");
    session.createCheckpoint();
    session.createBranch("b");
    session.startTask("Ответ клиенту");
    session.pauseTask();
    session.clearTask();
    session.clearMemory("working");
    session.clearProfile();
    session.reset();

    expect(session.getInvariants()).toEqual(LISTED);
    const files = readdirSync(directory).map((name) => readFileSync(join(directory, name), "utf8"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      for (const { id, description } of LISTED) {
        expect(file).not.toContain(id);
        expect(file).not.toContain(description);
      }
    }
  });

  it("allows reading the invariants during a turn", async () => {
    let finish!: (response: LlmCompletion) => void;
    const { session, client } = setup({ invariants: SUPPORT_INVARIANTS });
    client.create = () =>
      new Promise((resolve) => {
        finish = resolve;
      });

    const turn = session.respond("вопрос");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(session.getInvariants()).toEqual(LISTED);
    finish(completionResponse({ model: "m", messages: [] }, { content: "Срок уточняется." }));
    await expect(turn).resolves.toMatchObject({ text: "Срок уточняется." });
  });

  it("returns an empty list for an agent without invariants", () => {
    expect(setup().session.getInvariants()).toEqual([]);
  });
});
