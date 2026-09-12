import { describe, expect, it, vi } from "vitest";
import { Agent, AgentBusyError, type AgentConfig, AgentConfigError } from "../src/agent.ts";
import { DEFAULT_AGENT_CONFIG } from "../src/config.ts";
import type { HistoryMessage, HistoryRepository, HistoryState } from "../src/history.ts";
import type { DeepSeekParams, LlmCompletion } from "../src/llm-client.ts";
import { estimateContextTokens } from "../src/tokens.ts";
import { completionResponse, type FakeReply, fakeClient } from "./support/fake-client.ts";

function messages(count: number): HistoryMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: ` сообщение ${i} \n`,
  }));
}
function setup(
  replies: Array<FakeReply | Error>,
  state: HistoryState = { summary: null, messages: messages(20) },
  config: Partial<AgentConfig> = {},
) {
  const fake = fakeClient(replies);
  const repository = { load: vi.fn(() => state), save: vi.fn<HistoryRepository["save"]>() };
  const agent = new Agent({
    client: fake.client,
    historyRepository: repository,
    config: { ...DEFAULT_AGENT_CONFIG, ...config },
  });
  return { ...fake, repository, agent };
}
const summaryReply = { content: "Сводка", promptTokens: 10, completionTokens: 5, reasoningTokens: 2 };

describe("periodic compression", () => {
  it("compresses before turns 11 and 16, preserves the tail and replaces the previous summary", async () => {
    const replies: FakeReply[] = [];
    for (let turn = 1; turn <= 20; turn++) {
      if (turn === 11 || turn === 16) replies.push({ content: `summary-${turn}` });
      replies.push({ content: `answer-${turn}` });
    }
    const { agent, calls, repository } = setup(replies, { summary: null, messages: [] });
    for (let turn = 1; turn <= 20; turn++) {
      const result = await agent.respond(`question-${turn}`);
      expect(result.usage.summaryCall !== null).toBe(turn === 11 || turn === 16);
    }
    expect(calls).toHaveLength(22);
    const firstSource = JSON.parse(String(calls[10]!.messages[1]!.content));
    const secondSource = JSON.parse(String(calls[16]!.messages[1]!.content));
    expect(firstSource).toEqual({ summary: null, messages: repository.save.mock.calls[4]![0].messages });
    expect(secondSource).toEqual({
      summary: "summary-11",
      messages: repository.save.mock.calls[9]![0].messages.slice(10),
    });
    expect(calls[11]!.messages.slice(2, -1)).toEqual(repository.save.mock.calls[9]![0].messages.slice(10));
    expect(repository.save.mock.calls[10]![0].messages).toHaveLength(12);
    expect(repository.save.mock.calls[19]![0].summary).toBe("summary-16");
  });

  it.each([18, 20, 42])("uses only the saved messages at length %s", async (count) => {
    const state = { summary: null, messages: messages(count) };
    const compresses = count >= 20;
    const { agent, calls, repository } = setup(compresses ? [summaryReply, {}] : [{}], state);
    await agent.respond(" новый вопрос ");
    expect(calls).toHaveLength(compresses ? 2 : 1);
    if (compresses) {
      expect(JSON.parse(String(calls[0]!.messages[1]!.content))).toEqual({
        summary: null,
        messages: state.messages.slice(0, -10),
      });
      expect(calls[1]!.messages.slice(2, -1)).toEqual(state.messages.slice(-10));
      expect(repository.save.mock.calls[0]![0].messages.slice(0, -2)).toEqual(state.messages.slice(-10));
    }
    expect(calls.at(-1)!.messages.at(-1)).toEqual({ role: "user", content: "новый вопрос" });
  });

  it.each([null, "Ранее сохранённая сводка"])("keeps summary %s when compression is disabled", async (summary) => {
    const { agent, calls } = setup([{}], { summary, messages: messages(40) }, { historyCompressionEnabled: false });
    const result = await agent.respond("вопрос");
    expect(calls).toHaveLength(1);
    expect(result.usage.summaryCall).toBeNull();
    expect(calls[0]!.messages.slice(summary === null ? 1 : 2, -1)).toEqual(messages(40));
    if (summary !== null) {
      expect(calls[0]!.messages[1]).toMatchObject({ role: "user", content: expect.stringContaining(summary) });
      expect(calls[0]!.messages[0]!.content).not.toContain(summary);
    }
  });

  it("shares the candidate between meta and final, isolates summary policy and accounts for all calls", async () => {
    const { agent, calls } = setup(
      [
        summaryReply,
        { content: "meta instruction", totalTokens: 7 },
        { content: "{}", totalTokens: 9 },
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
    });
    expect(calls[0]).not.toHaveProperty("response_format");
    expect(calls[0]).not.toHaveProperty("stop");
    expect(calls[0]!.messages[0]!.content).not.toContain("3 слов");
    expect(calls[0]!.messages[0]!.content).not.toContain("END");
    expect(calls[1]!.messages.slice(1)).toEqual(calls[2]!.messages.slice(1));
    expect(result.tokenEstimate.contextTokens).toBe(
      estimateContextTokens(calls[2]!.messages as Array<{ content: string }>),
    );
    expect(result.usage.summaryCall).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      reasoningTokens: 2,
      totalTokens: 15,
    });
    expect(result.usage.finalCall.totalTokens).toBe(9);
    expect(result.usage.turn.totalTokens).toBe(31);
    expect(result.usage.session.totalTokens).toBe(31);
    result.usage.summaryCall!.totalTokens = 1000;
    result.usage.turn.totalTokens = 2000;
    expect(result.usage.session.totalTokens).toBe(31);
    expect((await agent.respond("ещё")).usage.session.totalTokens).toBe(32);
  });

  it.each([
    { stage: "summary transport", failed: [new Error("transport")], spent: 0 },
    { stage: "empty summary", failed: [{ ...summaryReply, content: " \n" }], spent: 15 },
    { stage: "truncated summary", failed: [{ ...summaryReply, finishReason: "length" as const }], spent: 15 },
    { stage: "meta transport", failed: [summaryReply, new Error("meta")], spent: 15 },
    { stage: "empty meta", failed: [summaryReply, { content: "", totalTokens: 7 }], spent: 22 },
    { stage: "final transport", failed: [summaryReply, { totalTokens: 7 }, new Error("final")], spent: 22 },
    { stage: "empty final", failed: [summaryReply, { totalTokens: 7 }, { content: "", totalTokens: 9 }], spent: 31 },
  ])("rolls back candidate after $stage and keeps spent usage", async ({ failed, spent }) => {
    const state = { summary: "old summary", messages: messages(20) };
    const { agent, calls, repository } = setup([...failed, summaryReply, {}, {}], state, { strategy: "meta" });
    await expect(agent.respond("failed question")).rejects.toThrow();
    expect(repository.save).not.toHaveBeenCalled();
    const result = await agent.respond("retry question");
    expect(calls[failed.length]!.messages).toEqual(calls[0]!.messages);
    expect(state).toEqual({ summary: "old summary", messages: messages(20) });
    expect(result.usage.session.totalTokens).toBe(spent + 15);
    expect(result.usage.turn.totalTokens).toBe(15);
  });

  it("rolls back summary and messages on save failure; preserves truncated invalid final answers on success", async () => {
    const { agent, calls, repository } = setup(
      [
        summaryReply,
        { content: "invalid", finishReason: "length", totalTokens: 3 },
        summaryReply,
        { content: "invalid", finishReason: "length" },
      ],
      undefined,
      { format: "json" },
    );
    repository.save.mockImplementationOnce((state) => {
      state.summary = "mutated";
      state.messages[0]!.content = "mutated";
      throw new Error("disk");
    });
    await expect(agent.respond("failed")).rejects.toThrow("disk");
    const result = await agent.respond("success");
    expect(calls[2]!.messages).toEqual(calls[0]!.messages);
    expect(result.finishReason).toBe("length");
    expect(result.validation.ok).toBe(false);
    expect(result.usage.session.totalTokens).toBe(33);
    expect(repository.save.mock.calls[1]![0].summary).toBe("Сводка");
  });

  it("reset saves both empty fields, preserves state and usage on failure, and keeps configuration", async () => {
    const { agent, repository, calls } = setup([summaryReply, {}, {}, {}], undefined, { model: "custom" });
    await agent.respond("first");
    repository.save.mockImplementationOnce(() => {
      throw new Error("reset disk");
    });
    expect(() => agent.reset()).toThrow("reset disk");
    const result = await agent.respond("second");
    expect(result.usage.session.totalTokens).toBe(15);
    expect(calls[2]!.messages[1]!.content).toContain("Сводка");
    agent.reset();
    expect(repository.save).toHaveBeenLastCalledWith({ summary: null, messages: [] });
    expect((await agent.respond("third")).usage.session.totalTokens).toBe(0);
    expect(calls[3]!.messages).toHaveLength(2);
    expect(calls[3]!.model).toBe("custom");
  });

  it.each([0, -2, 3, 2.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid N=%s before loading",
    (historyKeepLastMessages) => {
      expect(() => setup([], undefined, { historyKeepLastMessages })).toThrow(AgentConfigError);
    },
  );
  it("rejects a nonboolean compression flag", () => {
    expect(() => setup([], undefined, { historyCompressionEnabled: "true" as unknown as boolean })).toThrow(
      AgentConfigError,
    );
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
        return completionResponse(params, { content: "ok" });
      },
    };
    const agent = new Agent({
      client,
      config: { ...DEFAULT_AGENT_CONFIG, strategy: "meta" },
      historyRepository: {
        load: () => ({ summary: null, messages: messages(20) }),
        save(state) {
          if (state.messages.length) expect(() => agent.reset()).toThrow(AgentBusyError);
        },
      },
    });
    const pending = agent.respond("first");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(agent.respond("second")).rejects.toThrow(AgentBusyError);
    expect(() => agent.reset()).toThrow(AgentBusyError);
    release(completionResponse(calls[pendingIndex]!, {}));
    await pending;
    agent.reset();
  });

  it.each(["summary", "meta", "final"])("checks budget before %s and keeps previous state", async (stage) => {
    const config: Partial<AgentConfig> = { strategy: "meta", systemPrompt: "x", maxInputTokens: null };
    const question = stage === "meta" ? "q".repeat(6000) : "q";
    const preparation = stage === "final" ? "m".repeat(6000) : "m";
    const probe = setup([summaryReply, { content: preparation }, {}], undefined, config);
    await probe.agent.respond(question);
    const estimates = probe.calls.map((call) => estimateContextTokens(call.messages as Array<{ content: string }>));
    const index = stage === "summary" ? 0 : stage === "meta" ? 1 : 2;
    const limit = estimates[index]! - 1;
    expect(estimates.slice(0, index).every((n) => n <= limit)).toBe(true);
    const tested = setup([summaryReply, { content: preparation }, {}], undefined, { ...config, maxInputTokens: limit });
    await expect(tested.agent.respond(question)).rejects.toThrow(
      index === 0 ? "суммаризация" : index === 1 ? "meta" : "финальный ответ",
    );
    expect(tested.calls).toHaveLength(index);
    expect(tested.repository.save).not.toHaveBeenCalled();
    tested.agent.reset();
    const equal = setup([summaryReply, { content: preparation }, {}], undefined, {
      ...config,
      maxInputTokens: Math.max(...estimates),
    });
    await equal.agent.respond(question);
    expect(equal.calls).toHaveLength(3);
  });
});
