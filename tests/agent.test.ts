import { describe, expect, it, vi } from "vitest";
import {
  Agent,
  AgentBusyError,
  type AgentConfig,
  AgentConfigError,
  AgentInputError,
  AgentResponseError,
  type AgentResult,
} from "../src/agent.ts";
import { DEFAULT_AGENT_CONFIG } from "../src/config.ts";
import type { HistoryMessage, HistoryRepository } from "../src/history.ts";
import type { DeepSeekParams, LlmClient, LlmCompletion } from "../src/llm-client.ts";
import { completionResponse, type FakeReply, fakeClient, systemOf } from "./support/fake-client.ts";

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { ...DEFAULT_AGENT_CONFIG, ...overrides };
}

function fakeHistory(messages: HistoryMessage[] = []) {
  return {
    load: vi.fn<HistoryRepository["load"]>(() => messages),
    save: vi.fn<HistoryRepository["save"]>(),
  };
}

describe("Agent history", () => {
  it("sends the system prompt and first user message", async () => {
    const fake = fakeClient([{ content: "первый ответ" }]);
    const agent = new Agent({ client: fake.client, config: config() });

    const result = await agent.respond(" первый вопрос ");

    expect(result.text).toBe("первый ответ");
    expect(fake.calls[0]!.messages).toEqual([
      { role: "system", content: DEFAULT_AGENT_CONFIG.systemPrompt },
      { role: "user", content: "первый вопрос" },
    ]);
  });

  it("owns the message stack and sends successful turns on the next request", async () => {
    const fake = fakeClient([{ content: "первый ответ" }, { content: "второй ответ" }]);
    const agent = new Agent({ client: fake.client, config: config() });

    await agent.respond("первый вопрос");
    await agent.respond("второй вопрос");

    expect(fake.calls[1]!.messages).toEqual([
      { role: "system", content: DEFAULT_AGENT_CONFIG.systemPrompt },
      { role: "user", content: "первый вопрос" },
      { role: "assistant", content: "первый ответ" },
      { role: "user", content: "второй вопрос" },
    ]);
  });

  it("does not add a failed turn to history", async () => {
    const fake = fakeClient([
      { content: "первый ответ", totalTokens: 5 },
      new Error("API недоступен"),
      { content: "третий ответ", totalTokens: 3 },
    ]);
    const historyRepository = fakeHistory();
    const agent = new Agent({ client: fake.client, config: config(), historyRepository });

    await agent.respond("первый вопрос");
    await expect(agent.respond("сломанный вопрос")).rejects.toThrow("API недоступен");
    expect(historyRepository.save).toHaveBeenCalledTimes(1);
    const result = await agent.respond("третий вопрос");

    expect(fake.calls[2]!.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(fake.calls[2]!.messages).not.toContainEqual({ role: "user", content: "сломанный вопрос" });
    expect(result.usage.session.totalTokens).toBe(8);
    expect(historyRepository.save).toHaveBeenLastCalledWith([
      { role: "user", content: "первый вопрос" },
      { role: "assistant", content: "первый ответ" },
      { role: "user", content: "третий вопрос" },
      { role: "assistant", content: "третий ответ" },
    ]);
  });

  it("reset clears history while keeping the agent configuration", async () => {
    const fake = fakeClient([
      { content: "первый ответ", totalTokens: 9 },
      { content: "ответ после сброса", totalTokens: 4 },
    ]);
    const historyRepository = fakeHistory();
    const agent = new Agent({ client: fake.client, config: config({ model: "test-model" }), historyRepository });

    await agent.respond("первый вопрос");
    agent.reset();
    expect(historyRepository.save).toHaveBeenLastCalledWith([]);
    const result = await agent.respond("новый вопрос");

    expect(fake.calls[1]!.model).toBe("test-model");
    expect(fake.calls[1]!.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(result.usage.session.totalTokens).toBe(4);
  });
});

describe("Agent history repository", () => {
  const previousHistory: HistoryMessage[] = [
    { role: "user", content: "прошлый вопрос" },
    { role: "assistant", content: "прошлый ответ" },
  ];

  it("loads history once and saves completed pairs with usage starting at zero", async () => {
    const fake = fakeClient([{ content: "  новый ответ\n", totalTokens: 4 }, { content: "ещё ответ" }]);
    const historyRepository = fakeHistory(previousHistory);
    const agent = new Agent({ client: fake.client, config: config(), historyRepository });

    const result = await agent.respond("новый вопрос");

    expect(fake.calls[0]!.messages).toEqual([
      { role: "system", content: DEFAULT_AGENT_CONFIG.systemPrompt },
      ...previousHistory,
      { role: "user", content: "новый вопрос" },
    ]);
    expect(historyRepository.save).toHaveBeenCalledExactlyOnceWith([
      ...previousHistory,
      { role: "user", content: "новый вопрос" },
      { role: "assistant", content: "  новый ответ\n" },
    ]);
    expect(result.usage.session.totalTokens).toBe(4);

    await agent.respond("ещё вопрос");
    expect(historyRepository.load).toHaveBeenCalledOnce();
  });

  it("validates configuration before loading history and propagates load errors", () => {
    const fake = fakeClient([]);
    const historyRepository = fakeHistory();
    const failure = new Error("История недоступна");
    historyRepository.load.mockImplementation(() => {
      throw failure;
    });

    expect(() => new Agent({ client: fake.client, config: config({ model: " " }), historyRepository })).toThrow(
      AgentConfigError,
    );
    expect(historyRepository.load).not.toHaveBeenCalled();
    expect(() => new Agent({ client: fake.client, config: config(), historyRepository })).toThrow(failure);
    expect(historyRepository.save).not.toHaveBeenCalled();
    expect(fake.calls).toHaveLength(0);
  });

  it("detaches loaded messages and saved snapshots from the agent's history", async () => {
    const loaded = structuredClone(previousHistory);
    const fake = fakeClient([{ content: "первый ответ" }, { content: "второй ответ" }]);
    const snapshots: Array<readonly HistoryMessage[]> = [];
    const historyRepository: HistoryRepository = {
      load: () => loaded,
      save(messages) {
        snapshots.push(messages);
        messages[0]!.content = "изменено при сохранении";
        messages.at(-1)!.content = "изменён ответ при сохранении";
      },
    };
    const agent = new Agent({ client: fake.client, config: config(), historyRepository });

    loaded[0]!.content = "изменено после загрузки";
    loaded.pop();
    await agent.respond("первый вопрос");
    snapshots[0]![1]!.content = "изменено после сохранения";
    await agent.respond("второй вопрос");

    expect(fake.calls[1]!.messages.slice(1)).toEqual([
      ...previousHistory,
      { role: "user", content: "первый вопрос" },
      { role: "assistant", content: "первый ответ" },
      { role: "user", content: "второй вопрос" },
    ]);
    expect(snapshots[0]).toHaveLength(4);
    expect(snapshots[1]).toHaveLength(6);
    expect(snapshots[1]![1]!.content).toBe("прошлый ответ");
  });

  it("rejects a failed save without retrying the LLM or adding history, but keeps spent usage", async () => {
    const fake = fakeClient([
      { content: "несохранённый ответ", totalTokens: 7 },
      { content: "успешный ответ", totalTokens: 3 },
    ]);
    const historyRepository = fakeHistory(previousHistory);
    const failure = new Error("Нет места для истории");
    historyRepository.save.mockImplementationOnce((messages) => {
      messages[0]!.content = "изменено при неудачном сохранении";
      throw failure;
    });
    const agent = new Agent({ client: fake.client, config: config(), historyRepository });

    await expect(agent.respond("несохранённый вопрос")).rejects.toBe(failure);
    expect(fake.calls).toHaveLength(1);
    const result = await agent.respond("новый вопрос");

    expect(fake.calls[1]!.messages.slice(1)).toEqual([...previousHistory, { role: "user", content: "новый вопрос" }]);
    expect(historyRepository.save).toHaveBeenLastCalledWith([
      ...previousHistory,
      { role: "user", content: "новый вопрос" },
      { role: "assistant", content: "успешный ответ" },
    ]);
    expect(result.usage.turn.totalTokens).toBe(3);
    expect(result.usage.session.totalTokens).toBe(10);
  });

  it("preserves history and usage when saving a reset fails", async () => {
    const fake = fakeClient([
      { content: "первый ответ", totalTokens: 7 },
      { content: "второй ответ", totalTokens: 3 },
    ]);
    const historyRepository = fakeHistory(previousHistory);
    const agent = new Agent({ client: fake.client, config: config(), historyRepository });
    await agent.respond("первый вопрос");
    const failure = new Error("Не удалось сохранить пустую историю");
    historyRepository.save.mockImplementationOnce(() => {
      throw failure;
    });

    expect(() => agent.reset()).toThrow(failure);
    expect(historyRepository.save).toHaveBeenLastCalledWith([]);
    const result = await agent.respond("второй вопрос");

    expect(fake.calls[1]!.messages.slice(1)).toEqual([
      ...previousHistory,
      { role: "user", content: "первый вопрос" },
      { role: "assistant", content: "первый ответ" },
      { role: "user", content: "второй вопрос" },
    ]);
    expect(result.usage.session.totalTokens).toBe(10);
  });

  it("rejects concurrent calls and reset until saving is complete", async () => {
    const fake = fakeClient([{ content: "ответ" }]);
    const historyRepository = fakeHistory();
    const agent = new Agent({ client: fake.client, config: config(), historyRepository });
    let concurrent: Promise<AgentResult> | undefined;
    historyRepository.save.mockImplementationOnce(() => {
      concurrent = agent.respond("параллельный вопрос");
      expect(() => agent.reset()).toThrow(AgentBusyError);
    });

    await agent.respond("вопрос");
    await expect(concurrent).rejects.toBeInstanceOf(AgentBusyError);
    expect(fake.calls).toHaveLength(1);
    expect(() => agent.reset()).not.toThrow();
  });
});

describe("Agent request configuration", () => {
  it("owns a copy of its configuration", async () => {
    const fake = fakeClient([{}]);
    const mutableConfig = config({ model: "original-model", systemPrompt: "исходный промпт" });
    const agent = new Agent({ client: fake.client, config: mutableConfig });

    mutableConfig.model = "changed-model";
    mutableConfig.systemPrompt = "изменённый промпт";
    await agent.respond("вопрос");

    expect(fake.calls[0]!.model).toBe("original-model");
    expect(systemOf(fake.calls[0]!)).toContain("исходный промпт");
    expect(systemOf(fake.calls[0]!)).not.toContain("изменённый промпт");
  });

  it("applies the configured model, limits, stop marker, temperature and thinking mode", async () => {
    const fake = fakeClient([{ content: "ответ" }]);
    const agent = new Agent({
      client: fake.client,
      config: config({
        model: "test-model",
        maxWords: 12,
        maxTokens: 500,
        stopMarker: "<END>",
        temperature: 0,
        thinkingEnabled: false,
      }),
    });

    await agent.respond("вопрос");

    expect(fake.calls[0]).toMatchObject({
      model: "test-model",
      max_tokens: 500,
      stop: ["<END>"],
      temperature: 0,
      thinking: { type: "disabled" },
    });
    expect(systemOf(fake.calls[0]!)).toContain("Уложись в 12 слов.");
    expect(systemOf(fake.calls[0]!)).toContain("<END>");
  });

  it("omits optional API parameters when they are not configured", async () => {
    const fake = fakeClient([{}]);
    const agent = new Agent({ client: fake.client, config: config() });

    await agent.respond("вопрос");

    expect(fake.calls[0]).not.toHaveProperty("max_tokens");
    expect(fake.calls[0]).not.toHaveProperty("stop");
    expect(fake.calls[0]).not.toHaveProperty("temperature");
    expect(fake.calls[0]).not.toHaveProperty("thinking");
    expect(fake.calls[0]).not.toHaveProperty("response_format");
  });

  it("uses JSON response mode and drops the incompatible stop marker", async () => {
    const fake = fakeClient([{ content: '{"answer":42}' }]);
    const agent = new Agent({ client: fake.client, config: config({ format: "json", stopMarker: "<END>" }) });

    const result = await agent.respond("вопрос");

    expect(fake.calls[0]!.response_format).toEqual({ type: "json_object" });
    expect(fake.calls[0]).not.toHaveProperty("stop");
    expect(systemOf(fake.calls[0]!)).not.toContain("<END>");
    expect(result.validation).toEqual({ ok: true });
  });

  it.each(["steps", "experts"] as const)("adds the %s strategy to the system prompt", async (strategy) => {
    const fake = fakeClient([{}]);
    const agent = new Agent({ client: fake.client, config: config({ strategy }) });

    await agent.respond("вопрос");

    expect(systemOf(fake.calls[0]!)).toContain(strategy === "steps" ? "пошагово" : "группа экспертов");
  });

  it("runs meta preparation internally and keeps its prompt out of conversation history", async () => {
    const fake = fakeClient([
      {
        content: "сгенерированный промпт",
        promptTokens: 1,
        completionTokens: 2,
        reasoningTokens: 1,
        totalTokens: 3,
      },
      {
        content: "итоговый ответ",
        promptTokens: 4,
        completionTokens: 5,
        reasoningTokens: 3,
        totalTokens: 9,
      },
      { content: "следующий сгенерированный промпт", totalTokens: 2 },
      { content: "следующий ответ", totalTokens: 3 },
    ]);
    const historyRepository = fakeHistory();
    const agent = new Agent({
      client: fake.client,
      historyRepository,
      config: config({
        strategy: "meta",
        format: "markdown",
        maxWords: 20,
        maxTokens: 500,
        stopMarker: "<END>",
        temperature: 0,
        thinkingEnabled: false,
      }),
    });

    const result = await agent.respond("исходная задача");
    await agent.respond("продолжение");

    expect(fake.calls).toHaveLength(4);
    expect(systemOf(fake.calls[0]!)).toContain("Не решай задачу");
    expect(systemOf(fake.calls[0]!)).toContain(DEFAULT_AGENT_CONFIG.systemPrompt);
    expect(systemOf(fake.calls[0]!)).not.toContain("Уложись в 20 слов");
    expect(fake.calls[0]).toMatchObject({ max_tokens: 500, temperature: 0, thinking: { type: "disabled" } });
    expect(fake.calls[0]).not.toHaveProperty("stop");
    expect(fake.calls[0]).not.toHaveProperty("response_format");
    expect(systemOf(fake.calls[1]!)).toContain("сгенерированный промпт");
    expect(systemOf(fake.calls[1]!)).toContain(DEFAULT_AGENT_CONFIG.systemPrompt);
    expect(systemOf(fake.calls[1]!)).toContain("Уложись в 20 слов");
    expect(fake.calls[1]).toMatchObject({
      max_tokens: 500,
      temperature: 0,
      thinking: { type: "disabled" },
      stop: ["<END>"],
    });
    expect(fake.calls[2]!.messages).toContainEqual({ role: "assistant", content: "итоговый ответ" });
    expect(fake.calls[2]!.messages).not.toContainEqual({ role: "assistant", content: "сгенерированный промпт" });
    expect(result.usage.turn).toEqual({
      promptTokens: 5,
      completionTokens: 7,
      reasoningTokens: 4,
      totalTokens: 12,
    });
    expect(historyRepository.save).toHaveBeenLastCalledWith([
      { role: "user", content: "исходная задача" },
      { role: "assistant", content: "итоговый ответ" },
      { role: "user", content: "продолжение" },
      { role: "assistant", content: "следующий ответ" },
    ]);
  });

  it.each<{ name: string; failedReplies: Array<FakeReply | Error>; spentTokens: number }>([
    {
      name: "empty preparation",
      failedReplies: [{ content: null, finishReason: "length", totalTokens: 5 }],
      spentTokens: 5,
    },
    {
      name: "failed final call",
      failedReplies: [{ content: "первый промпт", totalTokens: 5 }, new Error("API недоступен")],
      spentTokens: 5,
    },
    {
      name: "empty final response",
      failedReplies: [
        { content: "первый промпт", totalTokens: 5 },
        { content: " ", finishReason: "length", totalTokens: 7 },
      ],
      spentTokens: 12,
    },
  ])("keeps spent usage but no history after $name", async ({ failedReplies, spentTokens }) => {
    const fake = fakeClient([
      ...failedReplies,
      { content: "новый промпт", totalTokens: 2 },
      { content: "успешный ответ", totalTokens: 3 },
    ]);
    const historyRepository = fakeHistory();
    const agent = new Agent({ client: fake.client, config: config({ strategy: "meta" }), historyRepository });

    await expect(agent.respond("незавершённый вопрос")).rejects.toThrow();
    expect(historyRepository.save).not.toHaveBeenCalled();
    const result = await agent.respond("новый вопрос");

    const nextPreparation = fake.calls[failedReplies.length]!;
    expect(nextPreparation.messages).toEqual([
      { role: "system", content: expect.stringContaining("Не решай задачу") },
      { role: "user", content: "новый вопрос" },
    ]);
    expect(result.usage.turn.totalTokens).toBe(5);
    expect(result.usage.session.totalTokens).toBe(spentTokens + 5);
    expect(historyRepository.save).toHaveBeenCalledExactlyOnceWith([
      { role: "user", content: "новый вопрос" },
      { role: "assistant", content: "успешный ответ" },
    ]);
  });
});

describe("Agent results and state", () => {
  it("returns turn usage and a detached snapshot of accumulated session usage", async () => {
    const fake = fakeClient([
      { content: "один", promptTokens: 10, completionTokens: 4, reasoningTokens: 2, totalTokens: 14 },
      { content: "два", promptTokens: 20, completionTokens: 6, reasoningTokens: 3, totalTokens: 26 },
    ]);
    const agent = new Agent({ client: fake.client, config: config() });

    const first = await agent.respond("раз");
    first.usage.session.totalTokens = 999;
    const second = await agent.respond("два");

    expect(first.usage).toEqual({
      turn: { promptTokens: 10, completionTokens: 4, reasoningTokens: 2, totalTokens: 14 },
      session: { promptTokens: 10, completionTokens: 4, reasoningTokens: 2, totalTokens: 999 },
    });
    expect(second.usage).toEqual({
      turn: { promptTokens: 20, completionTokens: 6, reasoningTokens: 3, totalTokens: 26 },
      session: { promptTokens: 30, completionTokens: 10, reasoningTokens: 5, totalTokens: 40 },
    });
    expect(second.usage.session.totalTokens).toBe(40);
  });

  it("derives total usage and returns zeros when the API omits usage", async () => {
    const fake = fakeClient([
      { content: "один", promptTokens: 4, completionTokens: 3, totalTokens: null },
      { content: "два", noUsage: true },
    ]);
    const agent = new Agent({ client: fake.client, config: config() });

    const first = await agent.respond("раз");
    const second = await agent.respond("два");

    expect(first.usage.turn.totalTokens).toBe(7);
    expect(second.usage.turn).toEqual({ promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 });
    expect(second.usage.session.totalTokens).toBe(7);
  });

  it("returns finish reason and format validation without exposing the SDK response", async () => {
    const fake = fakeClient([{ content: "обычный текст", finishReason: "length" }, { content: "следующий ответ" }]);
    const historyRepository = fakeHistory();
    const agent = new Agent({ client: fake.client, config: config({ format: "markdown" }), historyRepository });

    const result = await agent.respond("вопрос");

    expect(result).toMatchObject({
      text: "обычный текст",
      finishReason: "length",
      validation: { ok: false, reason: "нет заголовка Markdown" },
    });
    expect(result).not.toHaveProperty("choices");
    expect(historyRepository.save).toHaveBeenCalledExactlyOnceWith([
      { role: "user", content: "вопрос" },
      { role: "assistant", content: "обычный текст" },
    ]);

    await agent.respond("следующий вопрос");
    expect(fake.calls[1]!.messages).toContainEqual({ role: "assistant", content: "обычный текст" });
  });

  it("rejects blank input before an API call", async () => {
    const fake = fakeClient([]);
    const historyRepository = fakeHistory();
    const agent = new Agent({ client: fake.client, config: config(), historyRepository });

    await expect(agent.respond(" \n\t ")).rejects.toBeInstanceOf(AgentInputError);
    expect(fake.calls).toHaveLength(0);
    expect(historyRepository.save).not.toHaveBeenCalled();
  });

  it.each([{ content: null }, { content: "" }, { content: "   " }, { noChoices: true }])(
    "rejects an empty LLM response and keeps its usage",
    async (emptyReply) => {
      const fake = fakeClient([
        { ...emptyReply, finishReason: "length", totalTokens: 8 },
        { content: "следующий ответ", totalTokens: 3 },
      ]);
      const historyRepository = fakeHistory();
      const agent = new Agent({ client: fake.client, config: config(), historyRepository });

      await expect(agent.respond("пустой ответ")).rejects.toBeInstanceOf(AgentResponseError);
      expect(historyRepository.save).not.toHaveBeenCalled();
      const result = await agent.respond("следующий вопрос");

      expect(fake.calls[1]!.messages.map((message) => message.role)).toEqual(["system", "user"]);
      expect(result.usage.session.totalTokens).toBe(11);
      expect(historyRepository.save).toHaveBeenCalledExactlyOnceWith([
        { role: "user", content: "следующий вопрос" },
        { role: "assistant", content: "следующий ответ" },
      ]);
    },
  );

  it("does not mix concurrent turns or allow reset while a request is running", async () => {
    let finish: ((response: LlmCompletion) => void) | undefined;
    let params: DeepSeekParams | undefined;
    const pending = new Promise<LlmCompletion>((resolve) => {
      finish = resolve;
    });
    const client: LlmClient = {
      create(request) {
        params = request;
        return pending;
      },
    };
    const historyRepository = fakeHistory();
    const agent = new Agent({ client, config: config(), historyRepository });

    const active = agent.respond("первый вопрос");

    await expect(agent.respond("второй вопрос")).rejects.toBeInstanceOf(AgentBusyError);
    expect(() => agent.reset()).toThrow(AgentBusyError);
    expect(historyRepository.save).not.toHaveBeenCalled();

    finish!(completionResponse(params!, { content: "ответ" }));
    await expect(active).resolves.toMatchObject({ text: "ответ" });
    expect(historyRepository.save).toHaveBeenCalledOnce();
  });
});

describe("Agent configuration validation", () => {
  it.each([
    ["model", { model: " " }, "Модель"],
    ["system prompt", { systemPrompt: " " }, "Системный промпт"],
    ["maxWords", { maxWords: 0 }, "maxWords"],
    ["maxTokens", { maxTokens: 1.5 }, "maxTokens"],
    ["temperature below range", { temperature: -0.1 }, "temperature"],
    ["temperature above range", { temperature: 2.1 }, "temperature"],
    ["temperature NaN", { temperature: Number.NaN }, "temperature"],
    ["stop marker", { stopMarker: "" }, "stopMarker"],
  ])("rejects invalid %s", (_name, overrides, message) => {
    const fake = fakeClient([]);

    expect(() => new Agent({ client: fake.client, config: config(overrides) })).toThrow(message);
  });

  it("rejects strategy and format values outside their registries", () => {
    const fake = fakeClient([]);

    expect(
      () => new Agent({ client: fake.client, config: { ...config(), strategy: "unknown" } as unknown as AgentConfig }),
    ).toThrow(AgentConfigError);
    expect(
      () => new Agent({ client: fake.client, config: { ...config(), format: "xml" } as unknown as AgentConfig }),
    ).toThrow(AgentConfigError);
  });
});
