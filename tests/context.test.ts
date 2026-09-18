import { describe, expect, it, vi } from "vitest";
import { Agent, AgentBusyError, type AgentConfig, AgentConfigError } from "../src/agent.ts";
import { DEFAULT_AGENT_CONFIG } from "../src/config.ts";
import { emptyHistory, type HistoryMessage, type HistoryRepository, type HistoryState } from "../src/history.ts";
import {
  INVARIANTS_INSTRUCTION,
  INVARIANTS_META_INSTRUCTION,
  INVARIANTS_TITLE,
  invariantsBlock,
  invariantsRetryInstruction,
} from "../src/invariants.ts";
import type { DeepSeekParams, LlmCompletion } from "../src/llm-client.ts";
import { META_INSTRUCTION } from "../src/strategies.ts";
import { SUPPORT_INVARIANTS } from "../src/support-invariants.ts";
import { estimateContextTokens } from "../src/tokens.ts";
import { completionResponse, type FakeReply, fakeClient, systemOf } from "./support/fake-client.ts";

function messages(count: number): HistoryMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `сообщение ${i}`,
  }));
}
function setup(
  replies: Array<FakeReply | Error>,
  state: HistoryState = emptyHistory("facts"),
  config: Partial<AgentConfig> = {},
) {
  const fake = fakeClient(replies);
  const repository = { load: vi.fn(() => state), save: vi.fn<HistoryRepository["save"]>() };
  const agent = new Agent({
    client: fake.client,
    historyRepository: repository,
    config: { ...DEFAULT_AGENT_CONFIG, contextStrategy: state.kind, ...config },
  });
  return { ...fake, repository, agent };
}
const factsReply = { content: '{"budget":"96000"}', promptTokens: 10, completionTokens: 5, reasoningTokens: 2 };
function source(call: DeepSeekParams) {
  return JSON.parse(String(call.messages[1]!.content));
}

describe("sliding window", () => {
  it.each([0, 8, 10, 12, 42])(
    "sends at most N previous messages and saves at most N including the new pair from %s",
    async (count) => {
      const state: HistoryState = { kind: "sliding", messages: messages(count) };
      const { agent, calls, repository } = setup([{}, {}], state);
      const first = await agent.respond(" новый вопрос ");
      expect(calls).toHaveLength(1);
      expect(first.usage.factsCall).toBeNull();
      expect(calls[0]!.messages.slice(1, -1)).toEqual(state.messages.slice(-10));
      const saved = repository.save.mock.calls[0]![0];
      expect(saved).toEqual({
        kind: "sliding",
        messages: [
          ...state.messages,
          { role: "user", content: "новый вопрос" },
          { role: "assistant", content: "ответ" },
        ].slice(-10),
      });
      await agent.respond("следующий");
      expect(calls[1]!.messages.slice(1, -1)).toEqual(saved.kind === "sliding" ? saved.messages : []);
    },
  );

  it("keeps N=2 as one completed pair through successive turns", async () => {
    const { agent, repository, calls } = setup([{}, {}, {}], emptyHistory("sliding"), { historyKeepLastMessages: 2 });
    for (const question of ["a", "b", "c"]) await agent.respond(question);
    expect(calls[2]!.messages.slice(1)).toEqual([
      { role: "user", content: "b" },
      { role: "assistant", content: "ответ" },
      { role: "user", content: "c" },
    ]);
    expect(repository.save).toHaveBeenLastCalledWith({
      kind: "sliding",
      messages: [
        { role: "user", content: "c" },
        { role: "assistant", content: "ответ" },
      ],
    });
  });
});

describe("facts memory", () => {
  it.each(["код_разговора", "conversation_код", "café", "conversation code", "1code"])(
    "rejects invalid fact key %s without changing history",
    async (key) => {
      const { agent, repository, calls } = setup([{ ...factsReply, content: JSON.stringify({ [key]: "КЕДР" }) }]);
      await expect(agent.respond("вопрос")).rejects.toThrow("ключ факта должен начинаться с латинской буквы");
      expect(calls).toHaveLength(1);
      expect(repository.save).not.toHaveBeenCalled();
      expect(agent.getMemory().short).toEqual(emptyHistory("facts"));
    },
  );

  it("passes legacy keys to extraction and saves renamed keys with original values", async () => {
    const { agent, repository, calls } = setup([{ content: '{"conversation_code":"КЕДР"}' }, {}], {
      kind: "facts",
      facts: { код_разговора: "КЕДР" },
      messages: [],
    });
    await agent.respond("Какой код?");
    expect(source(calls[0]!).facts).toEqual({ код_разговора: "КЕДР" });
    expect(calls[0]!.messages[0]!.content).toContain("Прежние ключи на других языках переименуй");
    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({ facts: { conversation_code: "КЕДР" } }));
    expect(calls[1]!.messages[1]!.content).toContain('{"conversation_code":"КЕДР"}');
  });

  it.each([
    ['{"budget":84000}', "значение факта должно быть строкой, получено number"],
    ['{"email_report":true}', "значение факта должно быть строкой, получено boolean"],
    ['{"budget":null}', "значение факта должно быть строкой, получено null"],
    ['{"facts":{"project":"Север"}}', "значение факта должно быть строкой, получено object"],
    ['{"reports":["email"]}', "значение факта должно быть строкой, получено array"],
    ['{"budget":"  "}', "значение факта — пустая строка"],
    ['{" ":"Север"}', "ключ факта должен быть непустой строкой"],
    ["[]", "ожидается JSON-объект со строковыми значениями, получено array"],
    ["null", "ожидается JSON-объект со строковыми значениями, получено null"],
  ])("reports the schema violation for %s without committing the turn", async (content, reason) => {
    const { agent, repository, calls } = setup([{ content }]);
    await expect(
      agent.respond(
        "Учебное ТЗ проекта «Север»: бюджет 84000 рублей, запуск 17 октября 2026, нужен email-отчёт. Ответь только «Принято».",
      ),
    ).rejects.toThrow(`Ошибка обновления facts: ${reason}.`);
    expect(calls).toHaveLength(1);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("uses updated facts in the current answer, preserves them beyond the window and accepts replacement and deletion", async () => {
    const replies = [
      { content: '{"budget":"84000","deadline":"October"}' },
      {},
      factsReply,
      {},
      factsReply,
      {},
      { content: "{}" },
      {},
    ];
    const { agent, repository, calls } = setup(replies, undefined, { historyKeepLastMessages: 2 });
    await agent.respond("Бюджет 84000, срок October");
    await agent.respond("Бюджет теперь 96000, срок отменён");
    await agent.respond("Промежуточный вопрос");
    expect(source(calls[2]!).facts).toEqual({ budget: "84000", deadline: "October" });
    expect(source(calls[4]!).facts).toEqual({ budget: "96000" });
    expect(source(calls[4]!).messages).toHaveLength(2);
    expect(calls[5]!.messages[1]).toEqual({ role: "user", content: expect.stringContaining('{"budget":"96000"}') });
    expect(calls[5]!.messages).toHaveLength(5);
    expect(JSON.stringify(calls[5])).not.toContain("84000");
    await agent.respond("Бюджет тоже отменён");
    expect(source(calls[6]!).facts).toEqual({ budget: "96000" });
    expect(repository.save).toHaveBeenLastCalledWith({
      kind: "facts",
      facts: {},
      messages: [
        { role: "user", content: "Бюджет тоже отменён" },
        { role: "assistant", content: "ответ" },
      ],
    });
  });

  it("detaches loaded facts and saved candidates from repository mutation", async () => {
    const state: HistoryState = { kind: "facts", facts: { budget: "84000" }, messages: messages(2) };
    const { agent, calls, repository } = setup([factsReply, {}, factsReply, {}], state);
    state.facts.budget = "mutated after load";
    state.messages[0]!.content = "mutated after load";
    repository.save.mockImplementation((snapshot) => {
      if (snapshot.kind !== "facts") throw new Error("Expected facts");
      snapshot.facts.budget = "mutated during save";
      snapshot.messages[0]!.content = "mutated during save";
    });
    await agent.respond("first");
    await agent.respond("second");
    expect(source(calls[0]!).facts).toEqual({ budget: "84000" });
    expect(source(calls[2]!).facts).toEqual({ budget: "96000" });
    expect(source(calls[2]!).messages[0]).toEqual(messages(2)[0]);
  });

  it("shares the candidate between meta and final, isolates facts policy and accounts for all calls", async () => {
    const { agent, calls } = setup(
      [
        factsReply,
        { content: "meta instruction", totalTokens: 7 },
        { content: "{}", totalTokens: 9 },
        { content: "{}" },
        {},
        { content: "{}", totalTokens: 1 },
      ],
      undefined,
      { strategy: "meta", format: "json", maxWords: 3, maxTokens: 8, stopMarker: "END", temperature: 0.4 },
    );
    const result = await agent.respond("вопрос");
    expect(calls[0]).toMatchObject({
      model: DEFAULT_AGENT_CONFIG.model,
      max_tokens: 512,
      thinking: { type: "disabled" },
      temperature: 0.4,
      response_format: { type: "json_object" },
    });
    expect(calls[0]).not.toHaveProperty("stop");
    expect(calls[0]!.messages[0]!.content).not.toContain("3 слов");
    expect(calls[0]!.messages[0]!.content).not.toContain("END");
    expect(calls[1]!.messages.slice(1)).toEqual(calls[2]!.messages.slice(1));
    expect(result.tokenEstimate.contextTokens).toBe(
      estimateContextTokens(calls[2]!.messages as Array<{ content: string }>),
    );
    expect(result.usage.factsCall).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      reasoningTokens: 2,
      totalTokens: 15,
    });
    expect(result.usage.finalCall.totalTokens).toBe(9);
    expect(result.usage.turn.totalTokens).toBe(31);
    expect(result.usage.session.totalTokens).toBe(31);
    result.usage.factsCall!.totalTokens = 1000;
    result.usage.turn.totalTokens = 2000;
    expect(result.usage.session.totalTokens).toBe(31);
    expect((await agent.respond("ещё")).usage.session.totalTokens).toBe(32);
  });

  it.each([
    { stage: "facts transport", failed: [new Error("transport")], spent: 0 },
    { stage: "empty facts", failed: [{ ...factsReply, content: " \n" }], spent: 15 },
    { stage: "truncated facts", failed: [{ ...factsReply, finishReason: "length" }], spent: 15 },
    { stage: "invalid JSON", failed: [{ ...factsReply, content: "{" }], spent: 15 },
    { stage: "non-Latin key", failed: [{ ...factsReply, content: '{"код":"КЕДР"}' }], spent: 15 },
    { stage: "invalid dictionary", failed: [{ ...factsReply, content: '{"budget":96000}' }], spent: 15 },
    { stage: "array", failed: [{ ...factsReply, content: "[]" }], spent: 15 },
    { stage: "null", failed: [{ ...factsReply, content: "null" }], spent: 15 },
    { stage: "meta transport", failed: [factsReply, new Error("meta")], spent: 15 },
    { stage: "empty meta", failed: [factsReply, { content: "", totalTokens: 7 }], spent: 22 },
    { stage: "final transport", failed: [factsReply, { totalTokens: 7 }, new Error("final")], spent: 22 },
    { stage: "empty final", failed: [factsReply, { totalTokens: 7 }, { content: "", totalTokens: 9 }], spent: 31 },
  ])("rolls back candidate after $stage and keeps spent usage", async ({ failed, spent }) => {
    const state: HistoryState = { kind: "facts", facts: { old: "fact" }, messages: messages(10) };
    const { agent, calls, repository } = setup([...failed, factsReply, {}, {}], state, { strategy: "meta" });
    await expect(agent.respond("question")).rejects.toThrow();
    expect(repository.save).not.toHaveBeenCalled();
    const result = await agent.respond("question");
    expect(calls[failed.length]!.messages).toEqual(calls[0]!.messages);
    expect(state).toEqual({ kind: "facts", facts: { old: "fact" }, messages: messages(10) });
    expect(result.usage.session.totalTokens).toBe(spent + 15);
    expect(result.usage.turn.totalTokens).toBe(15);
  });

  it("rolls back facts and messages on save failure and saves invalid nonempty final answers", async () => {
    const { agent, calls, repository } = setup(
      [
        factsReply,
        { content: "invalid", finishReason: "length", totalTokens: 3 },
        factsReply,
        { content: "invalid", finishReason: "length" },
      ],
      undefined,
      { format: "json" },
    );
    repository.save.mockImplementationOnce((state) => {
      if (state.kind !== "facts") throw new Error("Expected facts");
      state.facts.budget = "mutated";
      state.messages[0]!.content = "mutated";
      throw new Error("disk");
    });
    await expect(agent.respond("question")).rejects.toThrow("disk");
    const result = await agent.respond("question");
    expect(calls[2]!.messages).toEqual(calls[0]!.messages);
    expect(result.finishReason).toBe("length");
    expect(result.validation.ok).toBe(false);
    expect(result.usage.session.totalTokens).toBe(33);
    expect(repository.save).toHaveBeenLastCalledWith(expect.objectContaining({ facts: { budget: "96000" } }));
  });

  it("preserves facts and usage on failed reset, clears them on success and keeps configuration", async () => {
    const { agent, repository, calls } = setup(
      [factsReply, {}, { content: '{"budget":"96000"}' }, {}, { content: "{}" }, {}],
      undefined,
      { model: "custom" },
    );
    await agent.respond("first");
    repository.save.mockImplementationOnce(() => {
      throw new Error("reset disk");
    });
    expect(() => agent.reset()).toThrow("reset disk");
    const second = await agent.respond("second");
    expect(second.usage.session.totalTokens).toBe(15);
    expect(source(calls[2]!).facts).toEqual({ budget: "96000" });
    agent.reset();
    expect(repository.save).toHaveBeenLastCalledWith(emptyHistory("facts"));
    expect((await agent.respond("third")).usage.session.totalTokens).toBe(0);
    expect(source(calls[4]!)).toEqual({ facts: {}, messages: [], question: "third" });
    expect(calls[4]!.model).toBe("custom");
  });

  it.each([0, 1, 2])("holds busy while call %s is pending", async (pendingIndex) => {
    let release!: (value: LlmCompletion) => void;
    const calls: DeepSeekParams[] = [];
    const client = {
      async create(params: DeepSeekParams) {
        calls.push(params);
        if (calls.length - 1 === pendingIndex)
          return new Promise<LlmCompletion>((resolve) => {
            release = resolve;
          });
        return completionResponse(params, { content: "{}" });
      },
    };
    const agent = new Agent({
      client,
      config: { ...DEFAULT_AGENT_CONFIG, contextStrategy: "facts", strategy: "meta" },
    });
    const pending = agent.respond("first");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(agent.respond("second")).rejects.toThrow(AgentBusyError);
    expect(() => agent.reset()).toThrow(AgentBusyError);
    release(completionResponse(calls[pendingIndex]!, { content: "{}" }));
    await pending;
    agent.reset();
  });

  it.each(["facts", "meta", "final"])(
    "checks budget before %s, retains spent usage and allows equality",
    async (stage) => {
      const config: Partial<AgentConfig> = {
        strategy: "meta",
        systemPrompt: stage === "meta" ? "s".repeat(10000) : "x",
      };
      const preparation = stage === "final" ? "m".repeat(10000) : "m";
      const replies = [factsReply, { content: preparation, totalTokens: 7 }, {}];
      const probe = setup(replies, undefined, config);
      await probe.agent.respond("q");
      const estimates = probe.calls.map((call) => estimateContextTokens(call.messages as Array<{ content: string }>));
      const index = stage === "facts" ? 0 : stage === "meta" ? 1 : 2;
      const limit = estimates[index]! - 1;
      expect(estimates.slice(0, index).every((n) => n <= limit)).toBe(true);
      const tested = setup([...replies.slice(0, index), { content: "{}" }, { content: "m" }, {}], undefined, {
        ...config,
        maxInputTokens: limit,
      });
      await expect(tested.agent.respond("q")).rejects.toThrow(
        index === 0 ? "обновление facts" : index === 1 ? "meta" : "финальный ответ",
      );
      expect(tested.calls).toHaveLength(index);
      expect(tested.repository.save).not.toHaveBeenCalled();
      if (stage === "final") {
        const recovered = await tested.agent.respond("q");
        expect(recovered.usage.session.totalTokens).toBe(22);
        expect(recovered.usage.turn.totalTokens).toBe(0);
      }
      tested.agent.reset();
      const equal = setup(replies, undefined, { ...config, maxInputTokens: Math.max(...estimates) });
      await equal.agent.respond("q");
      expect(equal.calls).toHaveLength(3);
    },
  );
});

describe("invariants across context strategies", () => {
  const VIOLATING = "Мы доставим заказ завтра.";
  const SAFE = "Срок доставки уточняется.";
  const DEADLINE = [{ id: SUPPORT_INVARIANTS[0]!.id, description: SUPPORT_INVARIANTS[0]!.description }];

  function invariantSetup(state: HistoryState, replies: FakeReply[], config: Partial<AgentConfig> = {}) {
    const fake = fakeClient(replies);
    const repository = { load: vi.fn(() => structuredClone(state)), save: vi.fn<HistoryRepository["save"]>() };
    const agent = new Agent({
      client: fake.client,
      historyRepository: repository,
      config: { ...DEFAULT_AGENT_CONFIG, contextStrategy: state.kind, historyKeepLastMessages: 2, ...config },
      invariants: SUPPORT_INVARIANTS,
    });
    return { ...fake, repository, agent };
  }

  it.each<{ name: string; state: HistoryState; config?: Partial<AgentConfig>; service: FakeReply[] }>([
    {
      name: "no strategy",
      state: { kind: "compression", summary: "Прежнее summary", messages: messages(4) },
      config: { contextStrategy: null },
      service: [],
    },
    {
      name: "compression",
      state: { kind: "compression", summary: null, messages: messages(12) },
      service: [{ content: "Сводка", totalTokens: 2 }],
    },
    { name: "sliding", state: { kind: "sliding", messages: messages(6) }, service: [] },
    {
      name: "facts",
      state: { kind: "facts", facts: { city: "Казань" }, messages: messages(6) },
      service: [{ content: '{"city":"Казань"}', totalTokens: 2 }],
    },
    {
      name: "branching",
      state: {
        kind: "branching",
        activeBranch: "a",
        branches: { main: messages(2), a: messages(6) },
        checkpoint: messages(2),
      },
      service: [],
    },
  ])("$name: retries only the final call on the same candidate, service calls get no invariants", async (testCase) => {
    const { agent, calls, repository } = invariantSetup(
      testCase.state,
      [...testCase.service, { content: VIOLATING, totalTokens: 7 }, { content: SAFE, totalTokens: 3 }],
      testCase.config,
    );

    const result = await agent.respond("вопрос");

    expect(calls).toHaveLength(testCase.service.length + 2);
    for (const call of calls.slice(0, testCase.service.length)) {
      expect(JSON.stringify(call)).not.toContain(INVARIANTS_TITLE);
      expect(systemOf(call)).not.toContain(INVARIANTS_INSTRUCTION);
    }
    const [first, retry] = calls.slice(testCase.service.length);
    expect(first!.messages[1]).toEqual({ role: "user", content: invariantsBlock(SUPPORT_INVARIANTS) });
    expect(systemOf(first!)).toContain(INVARIANTS_INSTRUCTION);
    expect(retry!.messages.slice(1)).toEqual(first!.messages.slice(1));
    expect(systemOf(retry!)).toBe(`${systemOf(first!)}\n\n${invariantsRetryInstruction(DEADLINE)}`);
    expect(result.text).toBe(SAFE);
    expect(result.usage.turn.totalTokens).toBe(testCase.service.length * 2 + 10);
    expect(repository.save).toHaveBeenCalledOnce();
    const saved = JSON.stringify(repository.save.mock.calls[0]![0]);
    expect(saved).toContain(SAFE);
    expect(saved).not.toContain(VIOLATING);
    expect(saved).not.toContain(INVARIANTS_TITLE);
  });

  it("meta: prepares once on the same invariants snapshot and retries only the final call", async () => {
    const { agent, calls, repository } = invariantSetup(
      { kind: "sliding", messages: messages(2) },
      [
        { content: "Подготовленный промпт", totalTokens: 2 },
        { content: VIOLATING, totalTokens: 7 },
        { content: SAFE, totalTokens: 3 },
      ],
      { strategy: "meta" },
    );

    const result = await agent.respond("вопрос");

    expect(calls).toHaveLength(3);
    const [meta, first, retry] = calls;
    expect(meta!.messages.slice(1)).toEqual(first!.messages.slice(1));
    expect(meta!.messages[1]).toEqual({ role: "user", content: invariantsBlock(SUPPORT_INVARIANTS) });
    expect(systemOf(meta!)).toContain(`${INVARIANTS_INSTRUCTION}\n\n${META_INSTRUCTION}`);
    expect(systemOf(meta!).endsWith(INVARIANTS_META_INSTRUCTION)).toBe(true);
    expect(systemOf(first!)).toContain(INVARIANTS_INSTRUCTION);
    expect(systemOf(first!)).toContain("Подготовленный промпт");
    expect(systemOf(first!)).not.toContain(INVARIANTS_META_INSTRUCTION);
    expect(systemOf(retry!)).toBe(`${systemOf(first!)}\n\n${invariantsRetryInstruction(DEADLINE)}`);
    expect(result.usage.finalCall.totalTokens).toBe(3);
    expect(result.usage.turn.totalTokens).toBe(12);
    const saved = JSON.stringify(repository.save.mock.calls);
    expect(saved).not.toContain("Подготовленный промпт");
    expect(saved).not.toContain(VIOLATING);
  });
});

it.each([0, -2, 3, 2.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid N=%s",
  (historyKeepLastMessages) => {
    expect(() => setup([], undefined, { historyKeepLastMessages })).toThrow(AgentConfigError);
  },
);
it("rejects unknown context strategy and mismatched saved state", () => {
  expect(() => setup([], undefined, { contextStrategy: "unknown" } as unknown as AgentConfig)).toThrow(
    "Неизвестная стратегия контекста",
  );
  expect(() => setup([], undefined, { contextStrategy: "sliding" })).toThrow("не совпадает");
});
