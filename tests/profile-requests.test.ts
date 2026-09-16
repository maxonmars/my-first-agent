import { describe, expect, it, vi } from "vitest";
import { Agent, type AgentConfig, AgentContextLimitError } from "../src/agent.ts";
import { DEFAULT_AGENT_CONFIG } from "../src/config.ts";
import { emptyHistory, type HistoryMessage, type HistoryRepository, type HistoryState } from "../src/history.ts";
import type { DeepSeekParams } from "../src/llm-client.ts";
import {
  LONG_TERM_MEMORY_TITLE,
  MEMORY_INSTRUCTION,
  type MemoryEntries,
  type MemoryRepository,
  WORKING_MEMORY_TITLE,
} from "../src/memory.ts";
import { PROFILE_INSTRUCTION, PROFILE_META_INSTRUCTION, PROFILE_TITLE, type UserProfile } from "../src/profile.ts";
import { estimateContextTokens } from "../src/tokens.ts";
import { type FakeReply, fakeClient, systemOf } from "./support/fake-client.ts";

const profile: UserProfile = { style: "На ты, списком", constraints: "Без эмодзи", context: "Backend-разработчик" };

interface SetupOptions {
  state?: HistoryState;
  replies?: Array<FakeReply | Error>;
  config?: Partial<AgentConfig>;
  provider?: () => UserProfile;
  working?: MemoryEntries;
  long?: MemoryEntries;
}

function setup({ state = emptyHistory("sliding"), replies, config = {}, provider, working, long }: SetupOptions) {
  const fake = fakeClient(replies ?? Array.from({ length: 10 }, () => ({ totalTokens: 5 })));
  const historyRepository = {
    load: vi.fn<HistoryRepository["load"]>(() => structuredClone(state)),
    save: vi.fn<HistoryRepository["save"]>(),
  };
  const memory = (entries: MemoryEntries | undefined) =>
    entries === undefined
      ? undefined
      : { load: () => structuredClone(entries), save: vi.fn<MemoryRepository["save"]>() };
  const agent = new Agent({
    client: fake.client,
    config: { ...DEFAULT_AGENT_CONFIG, contextStrategy: state.kind, ...config },
    historyRepository,
    ...(provider === undefined ? {} : { profileProvider: provider }),
    ...(working === undefined ? {} : { workingMemoryRepository: memory(working)! }),
    ...(long === undefined ? {} : { longTermMemoryRepository: memory(long)! }),
  });
  return { ...fake, agent, historyRepository };
}

function pairs(count: number): HistoryMessage[] {
  return Array.from({ length: count }, (_, i): HistoryMessage[] => [
    { role: "user", content: `ход ${i + 1}` },
    { role: "assistant", content: `ответ ${i + 1}` },
  ]).flat();
}

function profileBlock(value: UserProfile = profile) {
  return { role: "user", content: `${PROFILE_TITLE}\n${JSON.stringify(value)}` };
}

function estimate(call: DeepSeekParams): number {
  return estimateContextTokens(call.messages as Array<{ content: string }>);
}

describe("profile in requests", () => {
  it.each<{ name: string; config: Partial<AgentConfig>; state: HistoryState; replies: FakeReply[] }>([
    {
      name: "no strategy",
      config: { contextStrategy: null },
      state: { kind: "compression", summary: "Прежнее summary", messages: pairs(2) },
      replies: [{}],
    },
    {
      name: "compression",
      config: {},
      state: { kind: "compression", summary: null, messages: pairs(6) },
      replies: [{ content: "Сводка" }, {}],
    },
    { name: "sliding", config: {}, state: { kind: "sliding", messages: pairs(3) }, replies: [{}] },
    {
      name: "facts",
      config: {},
      state: { kind: "facts", facts: { city: "Казань" }, messages: pairs(3) },
      replies: [{ content: '{"city":"Казань"}' }, {}],
    },
    {
      name: "branching",
      config: {},
      state: { kind: "branching", activeBranch: "a", branches: { main: pairs(1), a: pairs(3) }, checkpoint: pairs(1) },
      replies: [{}],
    },
  ])("$name: adds the profile after system, keeps service calls and history unchanged", async (testCase) => {
    const config = { ...testCase.config, historyKeepLastMessages: 2 };
    const baseline = setup({ state: testCase.state, replies: testCase.replies, config });
    const empty = setup({ state: testCase.state, replies: testCase.replies, config, provider: () => ({}) });
    const withProfile = setup({ state: testCase.state, replies: testCase.replies, config, provider: () => profile });

    const results = [];
    for (const run of [baseline, empty, withProfile]) results.push(await run.agent.respond("контрольный вопрос"));

    expect(empty.calls).toEqual(baseline.calls);
    expect(results[1]!.tokenEstimate).toEqual(results[0]!.tokenEstimate);
    const baselineFinal = baseline.calls.at(-1)!;
    expect(withProfile.calls.at(-1)!.messages).toEqual([
      { role: "system", content: `${systemOf(baselineFinal)}\n\n${PROFILE_INSTRUCTION}` },
      profileBlock(),
      ...baselineFinal.messages.slice(1),
    ]);
    expect(withProfile.calls.slice(0, -1)).toEqual(baseline.calls.slice(0, -1));
    expect(JSON.stringify(withProfile.calls.slice(0, -1))).not.toContain("Backend");
    expect(withProfile.historyRepository.save.mock.calls).toEqual(baseline.historyRepository.save.mock.calls);
    expect(results[2]!.tokenEstimate.contextTokens).toBe(estimate(withProfile.calls.at(-1)!));
  });

  it("places the profile before long and working memory and its instruction before the memory instruction", async () => {
    const { agent, calls } = setup({
      provider: () => profile,
      working: { task: "кеш" },
      long: { language: "TypeScript" },
      state: { kind: "sliding", messages: pairs(1) },
    });

    await agent.respond("вопрос");

    expect(calls[0]!.messages).toEqual([
      {
        role: "system",
        content: `${DEFAULT_AGENT_CONFIG.systemPrompt}\n\n${PROFILE_INSTRUCTION}\n\n${MEMORY_INSTRUCTION}`,
      },
      profileBlock(),
      { role: "user", content: `${LONG_TERM_MEMORY_TITLE}\n{"language":"TypeScript"}` },
      { role: "user", content: `${WORKING_MEMORY_TITLE}\n{"task":"кеш"}` },
      ...pairs(1),
      { role: "user", content: "вопрос" },
    ]);
  });

  it("keeps the output policy of AgentConfig after the profile instruction", async () => {
    const { agent, calls } = setup({
      provider: () => profile,
      config: { format: "markdown", maxWords: 50 },
      replies: [{ content: "# Ответ" }],
    });

    await agent.respond("вопрос");

    const system = systemOf(calls[0]!);
    expect(system.indexOf(PROFILE_INSTRUCTION)).toBeGreaterThan(0);
    expect(system.indexOf("Уложись в 50 слов.")).toBeGreaterThan(system.indexOf(PROFILE_INSTRUCTION));
    expect(system).toContain("Оформи ответ в Markdown");
    expect(PROFILE_INSTRUCTION).toContain("уточняет общую рекомендацию отвечать кратко");
    expect(PROFILE_INSTRUCTION).toContain("текущий запрос, затем рабочая память, затем профиль");
  });

  it.each<{ name: string; state: HistoryState; replies: FakeReply[] }>([
    {
      name: "compression",
      state: { kind: "compression", summary: null, messages: pairs(10) },
      replies: [{ content: "Сводка" }, { content: "Подготовленный промпт" }, {}],
    },
    {
      name: "facts",
      state: { kind: "facts", facts: {}, messages: pairs(2) },
      replies: [{ content: '{"code":"КЕДР"}' }, { content: "Подготовленный промпт" }, {}],
    },
  ])("$name: reads the profile once and gives meta and final the same snapshot", async ({ state, replies }) => {
    let version = 0;
    const current: UserProfile = { ...profile };
    const provider = vi.fn(() => {
      version += 1;
      return version === 1 ? current : { style: "изменённый профиль" };
    });
    const { agent, calls, client } = setup({
      state,
      replies,
      config: { strategy: "meta", historyKeepLastMessages: 2 },
      provider,
    });
    const create = client.create.bind(client);
    client.create = async (params) => {
      current.style = "изменено во время хода";
      return create(params);
    };

    await agent.respond("вопрос");

    expect(provider).toHaveBeenCalledOnce();
    const [service, meta, final] = calls;
    expect(JSON.stringify(service)).not.toContain(PROFILE_TITLE);
    expect(JSON.stringify(service)).not.toContain("Backend");
    expect(meta!.messages[1]).toEqual(profileBlock());
    expect(final!.messages.slice(1)).toEqual(meta!.messages.slice(1));
    expect(systemOf(meta!)).toContain(PROFILE_INSTRUCTION);
    expect(systemOf(meta!).endsWith(PROFILE_META_INSTRUCTION)).toBe(true);
    expect(systemOf(final!)).toContain(PROFILE_INSTRUCTION);
    expect(systemOf(final!)).not.toContain(PROFILE_META_INSTRUCTION);
  });

  it("does not store the profile in history and keeps the provider untouched by a turn", async () => {
    const provider = vi.fn(() => profile);
    const { agent, historyRepository } = setup({
      provider,
      state: emptyHistory("facts"),
      replies: [{ content: "{}" }, {}],
    });

    await agent.respond("вопрос");

    expect(JSON.stringify(historyRepository.save.mock.calls)).not.toContain("Backend");
    expect(JSON.stringify(agent.getMemory())).not.toContain("Backend");
    expect(profile).toEqual({ style: "На ты, списком", constraints: "Без эмодзи", context: "Backend-разработчик" });
  });

  it.each(["direct", "meta"] as const)(
    "%s: counts the profile in the budget and mentions /profile in the overflow hint",
    async (strategy) => {
      const replies: FakeReply[] = [...(strategy === "meta" ? [{ content: "Подготовка", totalTokens: 7 }] : []), {}];
      const config: Partial<AgentConfig> = { strategy };
      const large: UserProfile = { context: "опыт ".repeat(1000) };

      const baseline = setup({ replies, config });
      await baseline.agent.respond("вопрос");
      const limit = Math.max(...baseline.calls.map(estimate));
      const tested = setup({ replies, config: { ...config, maxInputTokens: limit }, provider: () => large });

      const refusal = tested.agent.respond("вопрос");
      await expect(refusal).rejects.toThrow(AgentContextLimitError);
      await expect(refusal).rejects.toThrow(strategy === "meta" ? "Этап «meta»" : "Этап «финальный ответ»");
      await expect(refusal).rejects.toThrow("/profile delete или /profile clear");
      expect(tested.calls).toEqual([]);
      expect(tested.historyRepository.save).not.toHaveBeenCalled();

      const withoutProfile = setup({ replies, config: { ...config, maxInputTokens: 1 } });
      const plainRefusal = withoutProfile.agent.respond("вопрос");
      await expect(plainRefusal).rejects.toThrow("Сократите вопрос или очистите историю командой /reset.");
      await expect(withoutProfile.agent.respond("вопрос")).rejects.not.toThrow("/profile");
    },
  );

  it("mentions both memory and profile hints when both are present", async () => {
    const { agent } = setup({
      provider: () => profile,
      long: { language: "TypeScript" },
      config: { maxInputTokens: 1 },
    });
    const refusal = agent.respond("вопрос");
    await expect(refusal).rejects.toThrow("/memory delete или /memory clear");
    await expect(refusal).rejects.toThrow("/profile delete или /profile clear");
  });
});
