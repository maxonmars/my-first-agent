import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  Agent,
  AgentBusyError,
  type AgentConfig,
  AgentConfigError,
  AgentContextLimitError,
  AgentMemoryError,
  AgentResponseError,
} from "../src/agent.ts";
import { DEFAULT_AGENT_CONFIG } from "../src/config.ts";
import { emptyHistory, type HistoryMessage, type HistoryRepository, type HistoryState } from "../src/history.ts";
import { JsonHistoryRepository } from "../src/json-history-repository.ts";
import { JsonMemoryRepository } from "../src/json-memory-repository.ts";
import type { DeepSeekParams, LlmCompletion } from "../src/llm-client.ts";
import {
  LONG_TERM_MEMORY_TITLE,
  MEMORY_INSTRUCTION,
  type MemoryEntries,
  type MemoryLayer,
  type MemoryRepository,
  WORKING_MEMORY_TITLE,
  type WritableMemoryLayer,
} from "../src/memory.ts";
import { estimateContextTokens } from "../src/tokens.ts";
import { completionResponse, type FakeReply, fakeClient, systemOf } from "./support/fake-client.ts";

const working = { goal: "поездка в Казань", budget: "30000 рублей" };
const long = { transport: "предпочитаю поезд" };

function memoryRepository(entries: MemoryEntries = {}) {
  return { load: vi.fn<MemoryRepository["load"]>(() => entries), save: vi.fn<MemoryRepository["save"]>() };
}

interface SetupOptions {
  state?: HistoryState;
  replies?: Array<FakeReply | Error>;
  config?: Partial<AgentConfig>;
  working?: MemoryEntries;
  long?: MemoryEntries;
}

// Без working/long агент создаётся без соответствующего репозитория — это эталон прежнего поведения.
function setup({ state = emptyHistory("sliding"), replies, config = {}, working: w, long: l }: SetupOptions = {}) {
  const fake = fakeClient(replies ?? Array.from({ length: 10 }, () => ({ totalTokens: 5 })));
  const historyRepository = {
    load: vi.fn<HistoryRepository["load"]>(() => structuredClone(state)),
    save: vi.fn<HistoryRepository["save"]>(),
  };
  const workingMemoryRepository = memoryRepository(w);
  const longTermMemoryRepository = memoryRepository(l);
  const agent = new Agent({
    client: fake.client,
    config: { ...DEFAULT_AGENT_CONFIG, contextStrategy: state.kind, ...config },
    historyRepository,
    ...(w === undefined ? {} : { workingMemoryRepository }),
    ...(l === undefined ? {} : { longTermMemoryRepository }),
  });
  return { ...fake, agent, historyRepository, workingMemoryRepository, longTermMemoryRepository };
}

function pairs(count: number): HistoryMessage[] {
  return Array.from({ length: count }, (_, i): HistoryMessage[] => [
    { role: "user", content: `ход ${i + 1}` },
    { role: "assistant", content: `ответ ${i + 1}` },
  ]).flat();
}

function memoryBlocks(workingEntries: MemoryEntries = working, longEntries: MemoryEntries = long) {
  return [
    { role: "user", content: `${LONG_TERM_MEMORY_TITLE}\n${JSON.stringify(longEntries)}` },
    { role: "user", content: `${WORKING_MEMORY_TITLE}\n${JSON.stringify(workingEntries)}` },
  ];
}

function estimate(call: DeepSeekParams): number {
  return estimateContextTokens(call.messages as Array<{ content: string }>);
}

describe("explicit memory commands", () => {
  it("change only the selected dictionary, while an ordinary turn changes only short-term history", async () => {
    const { agent, calls, historyRepository, workingMemoryRepository, longTermMemoryRepository } = setup({
      working: {},
      long: {},
    });

    const first = await agent.respond("Запомни, что я еду в Казань");
    expect(historyRepository.save).toHaveBeenCalledOnce();
    expect(agent.getMemory()).toEqual({
      short: {
        kind: "sliding",
        messages: [
          { role: "user", content: "Запомни, что я еду в Казань" },
          { role: "assistant", content: "ответ" },
        ],
      },
      working: {},
      long: {},
    });

    agent.setMemory("working", "goal", "  поездка в  Казань \n");
    agent.setMemory("working", "goal", "поездка в Казань");
    agent.setMemory("working", "Goal", "другой ключ");
    agent.setMemory("long", "transport", "предпочитаю поезд");
    expect(agent.deleteMemory("working", "Goal")).toBe(true);
    expect(agent.deleteMemory("working", "Goal")).toBe(false);
    expect(agent.deleteMemory("long", "toString")).toBe(false);

    expect(workingMemoryRepository.save.mock.calls).toEqual([
      [{ goal: "поездка в  Казань" }],
      [{ goal: "поездка в Казань" }],
      [{ goal: "поездка в Казань", Goal: "другой ключ" }],
      [{ goal: "поездка в Казань" }],
    ]);
    expect(longTermMemoryRepository.save.mock.calls).toEqual([[{ transport: "предпочитаю поезд" }]]);
    expect(historyRepository.save).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(1);

    const second = await agent.respond("Что дальше?");
    expect(second.usage.session.totalTokens).toBe(first.usage.session.totalTokens + 5);
    expect(workingMemoryRepository.save).toHaveBeenCalledTimes(4);
    expect(longTermMemoryRepository.save).toHaveBeenCalledOnce();
    expect(workingMemoryRepository.load).toHaveBeenCalledOnce();
    expect(longTermMemoryRepository.load).toHaveBeenCalledOnce();
    expect(agent.getMemory()).toMatchObject({ working: { goal: "поездка в Казань" }, long });
  });

  it("stores literal case-sensitive keys, including names of Object.prototype members", () => {
    const { agent } = setup({ working: {}, long: {} });
    for (const key of ["constructor", "toString", "Цель", "2026", "k".repeat(64)]) agent.setMemory("long", key, key);
    expect(agent.getMemory().long).toEqual({
      constructor: "constructor",
      toString: "toString",
      Цель: "Цель",
      "2026": "2026",
      ["k".repeat(64)]: "k".repeat(64),
    });
    expect(agent.deleteMemory("long", "constructor")).toBe(true);
    expect(Object.hasOwn(agent.getMemory().long, "constructor")).toBe(false);
  });

  it.each(["", "a b", "trip.city", "_goal", "-goal", "__proto__", "k".repeat(65)])(
    "rejects key %j without saving",
    (key) => {
      const { agent, workingMemoryRepository, longTermMemoryRepository } = setup({ working, long });
      expect(() => agent.setMemory("working", key, "значение")).toThrow(AgentMemoryError);
      expect(() => agent.deleteMemory("long", key)).toThrow("Ключ памяти: 1–64 символа");
      expect(workingMemoryRepository.save).not.toHaveBeenCalled();
      expect(longTermMemoryRepository.save).not.toHaveBeenCalled();
      expect(agent.getMemory()).toMatchObject({ working, long });
    },
  );

  it("rejects blank values and layers that are not writable", () => {
    const { agent, workingMemoryRepository, historyRepository } = setup({ working, long });
    expect(() => agent.setMemory("working", "goal", " \n\t ")).toThrow("Значение записи памяти не должно быть пустым.");
    expect(() => agent.setMemory("short" as WritableMemoryLayer, "goal", "x")).toThrow(
      "Слой памяти short недоступен для записи",
    );
    expect(() => agent.clearMemory("all" as MemoryLayer)).toThrow(AgentMemoryError);
    expect(workingMemoryRepository.save).not.toHaveBeenCalled();
    expect(historyRepository.save).not.toHaveBeenCalled();
  });
});

describe("memory layers in requests", () => {
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
      state: { kind: "compression", summary: "Прежнее summary", messages: pairs(2) },
      replies: [{}],
    },
    { name: "sliding", config: {}, state: { kind: "sliding", messages: pairs(3) }, replies: [{}] },
    {
      name: "facts",
      config: {},
      state: { kind: "facts", facts: { city: "Казань" }, messages: pairs(3) },
      replies: [{ content: '{"city":"Казань","code":"КЕДР"}' }, {}],
    },
    {
      name: "branching",
      config: {},
      state: { kind: "branching", activeBranch: "a", branches: { main: pairs(1), a: pairs(3) }, checkpoint: pairs(1) },
      replies: [{}],
    },
  ])("$name: adds non-empty layers before the existing stack and keeps history handling", async (testCase) => {
    const config = { ...testCase.config, historyKeepLastMessages: 2 };
    const baseline = setup({ state: testCase.state, replies: testCase.replies, config });
    const empty = setup({ state: testCase.state, replies: testCase.replies, config, working: {}, long: {} });
    const withMemory = setup({ state: testCase.state, replies: testCase.replies, config, working, long });

    for (const run of [baseline, empty, withMemory]) await run.agent.respond("контрольный вопрос");

    expect(empty.calls).toEqual(baseline.calls);
    const baselineFinal = baseline.calls.at(-1)!;
    expect(withMemory.calls.at(-1)!.messages).toEqual([
      { role: "system", content: `${systemOf(baselineFinal)}\n\n${MEMORY_INSTRUCTION}` },
      ...memoryBlocks(),
      ...baselineFinal.messages.slice(1),
    ]);
    expect(withMemory.calls.slice(0, -1)).toEqual(baseline.calls.slice(0, -1));
    expect(withMemory.historyRepository.save.mock.calls).toEqual(baseline.historyRepository.save.mock.calls);
    expect(withMemory.workingMemoryRepository.save).not.toHaveBeenCalled();
    expect(withMemory.longTermMemoryRepository.save).not.toHaveBeenCalled();
  });

  it("sends a single block when only one dictionary is non-empty", async () => {
    const { agent, calls } = setup({ working: {}, long });
    await agent.respond("вопрос");
    expect(calls[0]!.messages).toEqual([
      { role: "system", content: `${DEFAULT_AGENT_CONFIG.systemPrompt}\n\n${MEMORY_INSTRUCTION}` },
      memoryBlocks()[0],
      { role: "user", content: "вопрос" },
    ]);
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
  ])(
    "$name: keeps service request inputs and shares one memory snapshot between meta and final",
    async ({ state, replies }) => {
      const config: Partial<AgentConfig> = { strategy: "meta", historyKeepLastMessages: 2 };
      const baseline = setup({ state, replies, config });
      const withMemory = setup({ state, replies, config, working, long });

      await baseline.agent.respond("вопрос");
      const result = await withMemory.agent.respond("вопрос");

      const [service, meta, final] = withMemory.calls;
      expect(service).toEqual(baseline.calls[0]);
      expect(JSON.stringify(service)).not.toContain("поездка в Казань");
      expect(meta!.messages.slice(1)).toEqual(final!.messages.slice(1));
      expect(meta!.messages.slice(1, 3)).toEqual(memoryBlocks());
      expect(systemOf(meta!)).toContain(MEMORY_INSTRUCTION);
      expect(systemOf(final!)).toContain(MEMORY_INSTRUCTION);
      expect(result.tokenEstimate.contextTokens).toBe(estimate(final!));
      expect(withMemory.historyRepository.save.mock.calls).toEqual(baseline.historyRepository.save.mock.calls);
      expect(withMemory.workingMemoryRepository.save).not.toHaveBeenCalled();
      expect(withMemory.longTermMemoryRepository.save).not.toHaveBeenCalled();
      expect(withMemory.agent.getMemory()).toMatchObject({ working, long });
    },
  );

  it.each(["direct", "meta"] as const)(
    "%s: counts memory in the budget, blocks the call and keeps spent facts usage",
    async (strategy) => {
      const state = emptyHistory("facts");
      const replies: FakeReply[] = [
        { content: "{}", totalTokens: 15 },
        ...(strategy === "meta" ? [{ content: "Подготовка", totalTokens: 7 }] : []),
        { totalTokens: 3 },
      ];
      const config: Partial<AgentConfig> = { strategy };
      const largeLong = { notes: "поезд ".repeat(1000) };

      const baseline = setup({ state, replies, config });
      const probe = setup({ state, replies, config, working, long: largeLong });
      const baselineResult = await baseline.agent.respond("вопрос");
      const probeResult = await probe.agent.respond("вопрос");
      expect(probeResult.tokenEstimate.contextTokens).toBe(estimate(probe.calls.at(-1)!));
      expect(probeResult.tokenEstimate.contextTokens).toBeGreaterThan(
        baselineResult.tokenEstimate.contextTokens + 1500,
      );

      const limit = Math.max(...baseline.calls.map(estimate));
      const tested = setup({
        state,
        replies: [replies[0]!, ...replies],
        config: { ...config, maxInputTokens: limit },
        working,
        long: largeLong,
      });
      const refusal = tested.agent.respond("вопрос");
      await expect(refusal).rejects.toThrow(AgentContextLimitError);
      await expect(refusal).rejects.toThrow(strategy === "meta" ? "Этап «meta»" : "Этап «финальный ответ»");
      await expect(refusal).rejects.toThrow("/reset их сохраняет");
      expect(tested.calls).toEqual(baseline.calls.slice(0, 1));
      expect(tested.historyRepository.save).not.toHaveBeenCalled();
      expect(tested.agent.getMemory()).toEqual({ short: state, working, long: largeLong });

      expect(tested.agent.deleteMemory("long", "notes")).toBe(true);
      const recovered = await tested.agent.respond("вопрос");
      expect(recovered.usage.turn.totalTokens).toBe(baselineResult.usage.turn.totalTokens);
      expect(recovered.usage.session.totalTokens).toBe(15 + baselineResult.usage.turn.totalTokens);
    },
  );
});

describe("memory lifecycle", () => {
  it("shares working memory across branches without copying it into checkpoints or rolling it back", async () => {
    const { agent, calls, historyRepository, workingMemoryRepository } = setup({
      state: emptyHistory("branching"),
      working: { goal: "поездка в Казань" },
      long: {},
    });

    await agent.respond("общая цель");
    agent.createCheckpoint();
    agent.createBranch("a");
    agent.setMemory("working", "deadline", "1 ноября");
    await agent.respond("вариант A");
    agent.createBranch("b");
    agent.setMemory("working", "deadline", "15 ноября");
    agent.switchBranch("a");
    await agent.respond("проверка A");

    expect(calls[2]!.messages.slice(1)).toEqual([
      { role: "user", content: `${WORKING_MEMORY_TITLE}\n{"goal":"поездка в Казань","deadline":"15 ноября"}` },
      { role: "user", content: "общая цель" },
      { role: "assistant", content: "ответ" },
      { role: "user", content: "вариант A" },
      { role: "assistant", content: "ответ" },
      { role: "user", content: "проверка A" },
    ]);
    expect(workingMemoryRepository.save.mock.calls).toEqual([
      [{ goal: "поездка в Казань", deadline: "1 ноября" }],
      [{ goal: "поездка в Казань", deadline: "15 ноября" }],
    ]);
    for (const [saved] of historyRepository.save.mock.calls) expect(JSON.stringify(saved)).not.toContain("ноября");
    expect(agent.getMemory().short).toEqual(historyRepository.save.mock.lastCall![0]);
    agent.switchBranch("b");
    expect(agent.getMemory().working).toEqual({ goal: "поездка в Казань", deadline: "15 ноября" });
  });

  it("reset clears only the dialog and usage; each dictionary clears independently", async () => {
    const { agent, calls, historyRepository, workingMemoryRepository, longTermMemoryRepository } = setup({
      working,
      long,
    });

    await agent.respond("первый");
    agent.reset();
    expect(historyRepository.save).toHaveBeenLastCalledWith(emptyHistory("sliding"));
    expect(agent.getMemory()).toEqual({ short: emptyHistory("sliding"), working, long });
    const afterReset = await agent.respond("второй");
    expect(afterReset.usage.session.totalTokens).toBe(5);
    expect(calls[1]!.messages.slice(1)).toEqual([...memoryBlocks(), { role: "user", content: "второй" }]);

    agent.clearMemory("working");
    expect(workingMemoryRepository.save).toHaveBeenCalledExactlyOnceWith({});
    expect(longTermMemoryRepository.save).not.toHaveBeenCalled();
    expect(historyRepository.save).toHaveBeenCalledTimes(3);
    const afterClear = await agent.respond("третий");
    expect(afterClear.usage.session.totalTokens).toBe(10);
    expect(calls[2]!.messages.slice(1)).toEqual([
      memoryBlocks()[0],
      { role: "user", content: "второй" },
      { role: "assistant", content: "ответ" },
      { role: "user", content: "третий" },
    ]);

    agent.clearMemory("long");
    expect(longTermMemoryRepository.save).toHaveBeenCalledExactlyOnceWith({});
    agent.clearMemory("short");
    expect(historyRepository.save).toHaveBeenLastCalledWith(emptyHistory("sliding"));
    const fresh = await agent.respond("четвёртый");
    expect(fresh.usage.session.totalTokens).toBe(5);
    expect(calls[3]!.messages).toEqual([
      { role: "system", content: DEFAULT_AGENT_CONFIG.systemPrompt },
      { role: "user", content: "четвёртый" },
    ]);
  });

  it("restores all three layers from files after a restart with usage starting at zero", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-memory-restart-"));
    const create = (replies: FakeReply[]) => {
      const fake = fakeClient(replies);
      const agent = new Agent({
        client: fake.client,
        config: { ...DEFAULT_AGENT_CONFIG, contextStrategy: "sliding" },
        historyRepository: new JsonHistoryRepository(join(directory, ".agent-history.sliding.json")),
        workingMemoryRepository: new JsonMemoryRepository(join(directory, ".agent-memory.working.json"), "working"),
        longTermMemoryRepository: new JsonMemoryRepository(join(directory, ".agent-memory.long-term.json"), "long"),
      });
      return { ...fake, agent };
    };
    try {
      const first = create([{ content: "Принято", totalTokens: 5 }]);
      first.agent.setMemory("working", "goal", "поездка в Казань");
      first.agent.setMemory("long", "transport", "предпочитаю поезд");
      await first.agent.respond("Код разговора — КЕДР");

      const second = create([{ totalTokens: 3 }]);
      expect(second.agent.getMemory()).toEqual(first.agent.getMemory());
      const result = await second.agent.respond("вопрос");
      expect(result.usage.session.totalTokens).toBe(3);
      expect(second.calls[0]!.messages.slice(1)).toEqual([
        ...memoryBlocks({ goal: "поездка в Казань" }),
        { role: "user", content: "Код разговора — КЕДР" },
        { role: "assistant", content: "Принято" },
        { role: "user", content: "вопрос" },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("memory state guarantees", () => {
  it("validates configuration before loading memory and propagates load failures", () => {
    const { client } = fakeClient([]);
    const workingMemoryRepository = memoryRepository(working);
    const longTermMemoryRepository = memoryRepository(long);
    const options = { client, workingMemoryRepository, longTermMemoryRepository };

    expect(() => new Agent({ ...options, config: { ...DEFAULT_AGENT_CONFIG, model: " " } })).toThrow(AgentConfigError);
    expect(workingMemoryRepository.load).not.toHaveBeenCalled();
    expect(longTermMemoryRepository.load).not.toHaveBeenCalled();

    const failure = new Error("Не удалось загрузить память long");
    longTermMemoryRepository.load.mockImplementation(() => {
      throw failure;
    });
    expect(() => new Agent({ ...options, config: DEFAULT_AGENT_CONFIG })).toThrow(failure);
    expect(workingMemoryRepository.load).toHaveBeenCalledOnce();
    expect(workingMemoryRepository.save).not.toHaveBeenCalled();
    expect(longTermMemoryRepository.save).not.toHaveBeenCalled();
  });

  it.each(["working", "long"] as const)(
    "keeps all layers when saving %s fails after the repository mutates its argument",
    async (layer) => {
      const { agent, calls, historyRepository, workingMemoryRepository, longTermMemoryRepository } = setup({
        working,
        long,
      });
      const [failing, other] =
        layer === "working"
          ? [workingMemoryRepository, longTermMemoryRepository]
          : [longTermMemoryRepository, workingMemoryRepository];
      const key = layer === "working" ? "goal" : "transport";
      const before = agent.getMemory();

      for (const action of [
        () => agent.setMemory(layer, "extra", "значение"),
        () => agent.setMemory(layer, key, "замена"),
        () => agent.deleteMemory(layer, key),
        () => agent.clearMemory(layer),
      ]) {
        failing.save.mockImplementationOnce((entries) => {
          entries[key] = "изменено при сохранении";
          throw new Error("disk");
        });
        expect(action).toThrow("disk");
        expect(agent.getMemory()).toEqual(before);
      }

      expect(failing.save).toHaveBeenCalledTimes(4);
      expect(other.save).not.toHaveBeenCalled();
      expect(historyRepository.save).not.toHaveBeenCalled();
      await agent.respond("вопрос");
      expect(calls[0]!.messages.slice(1, 3)).toEqual(memoryBlocks());
    },
  );

  it("allows reading but blocks every memory mutation while a turn and its save are running", async () => {
    let release!: (value: LlmCompletion) => void;
    const historyRepository = { load: () => null, save: vi.fn<HistoryRepository["save"]>() };
    const workingMemoryRepository = memoryRepository(working);
    const longTermMemoryRepository = memoryRepository(long);
    const agent = new Agent({
      client: {
        create: () =>
          new Promise<LlmCompletion>((resolve) => {
            release = resolve;
          }),
      },
      config: { ...DEFAULT_AGENT_CONFIG, contextStrategy: "sliding" },
      historyRepository,
      workingMemoryRepository,
      longTermMemoryRepository,
    });
    const expectBlocked = () => {
      for (const mutation of [
        () => agent.setMemory("working", "goal", "другая"),
        () => agent.deleteMemory("long", "transport"),
        () => agent.clearMemory("working"),
        () => agent.clearMemory("long"),
        () => agent.clearMemory("short"),
      ]) {
        expect(mutation).toThrow(AgentBusyError);
      }
      expect(agent.getMemory()).toEqual({ short: emptyHistory("sliding"), working, long });
    };
    historyRepository.save.mockImplementationOnce(expectBlocked);

    const pending = agent.respond("вопрос");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expectBlocked();
    release(completionResponse({ model: "test", messages: [] }, { content: "ответ" }));
    await pending;

    expect(historyRepository.save).toHaveBeenCalledOnce();
    expect(workingMemoryRepository.save).not.toHaveBeenCalled();
    expect(longTermMemoryRepository.save).not.toHaveBeenCalled();
    agent.setMemory("working", "goal", "после ответа");
    expect(workingMemoryRepository.save).toHaveBeenCalledOnce();
  });

  it("detaches loaded, returned and saved dictionaries from agent state", async () => {
    const loadedWorking: MemoryEntries = { goal: "поездка в Казань" };
    const loadedLong: MemoryEntries = { transport: "предпочитаю поезд" };
    const { agent, calls, workingMemoryRepository } = setup({ working: loadedWorking, long: loadedLong });

    loadedWorking.goal = "изменено после загрузки";
    loadedLong.extra = "добавлено после загрузки";
    const snapshot = agent.getMemory();
    snapshot.working.goal = "изменено в снимке";
    snapshot.long.extra = "добавлено в снимок";
    if (snapshot.short.kind === "sliding") snapshot.short.messages.push({ role: "user", content: "изменено" });
    workingMemoryRepository.save.mockImplementation((entries) => {
      entries.goal = "изменено при сохранении";
    });
    agent.setMemory("working", "budget", "30000 рублей");
    await agent.respond("вопрос");

    expect(calls[0]!.messages.slice(1)).toEqual([...memoryBlocks(working, long), { role: "user", content: "вопрос" }]);
    expect(agent.getMemory().working).toEqual(working);
    expect(workingMemoryRepository.save.mock.calls[0]![0]).toEqual({ ...working, goal: "изменено при сохранении" });
  });

  it("leaves memory and history unchanged after API failures", async () => {
    const { agent, calls, historyRepository, workingMemoryRepository, longTermMemoryRepository } = setup({
      replies: [new Error("API недоступен"), { content: " ", totalTokens: 4 }, { totalTokens: 5 }],
      working,
      long,
    });

    await expect(agent.respond("первый")).rejects.toThrow("API недоступен");
    await expect(agent.respond("второй")).rejects.toThrow(AgentResponseError);
    const result = await agent.respond("третий");

    expect(result.usage.session.totalTokens).toBe(9);
    expect(calls[2]!.messages.slice(1)).toEqual([...memoryBlocks(), { role: "user", content: "третий" }]);
    expect(historyRepository.save).toHaveBeenCalledOnce();
    expect(workingMemoryRepository.save).not.toHaveBeenCalled();
    expect(longTermMemoryRepository.save).not.toHaveBeenCalled();
    expect(agent.getMemory()).toMatchObject({ working, long });
  });
});
