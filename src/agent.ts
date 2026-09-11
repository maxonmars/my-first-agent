import { FORMATS, type FormatName, type ValidationResult } from "./formats.ts";
import type { HistoryMessage, HistoryRepository } from "./history.ts";
import type { DeepSeekParams, LlmClient, LlmCompletion } from "./llm-client.ts";
import { META_INSTRUCTION, STRATEGIES, type StrategyName } from "./strategies.ts";
import { estimateContextTokens, estimateTextTokens } from "./tokens.ts";

export interface AgentConfig {
  model: string;
  systemPrompt: string;
  strategy: StrategyName;
  format: FormatName;
  maxWords: number | null;
  maxTokens: number | null;
  maxInputTokens: number | null;
  stopMarker: string | null;
  temperature: number | null;
  thinkingEnabled: boolean;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface AgentResult {
  text: string;
  finishReason: string;
  validation: ValidationResult;
  tokenEstimate: {
    questionTokens: number;
    contextTokens: number;
  };
  usage: {
    finalCall: TokenUsage;
    turn: TokenUsage;
    session: TokenUsage;
  };
}

export interface AgentOptions {
  client: LlmClient;
  config: AgentConfig;
  historyRepository?: HistoryRepository;
}

type PreparedParams = DeepSeekParams & {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
};

interface CompletionResult {
  contextTokens: number;
  text: string;
  finishReason: string;
  usage: TokenUsage;
}

export class AgentConfigError extends Error {}
export class AgentInputError extends Error {}
export class AgentResponseError extends Error {}
export class AgentBusyError extends Error {}
export class AgentContextLimitError extends Error {}

export class Agent {
  private readonly client: LlmClient;
  private readonly config: Readonly<AgentConfig>;
  private readonly historyRepository: HistoryRepository | undefined;
  private history: HistoryMessage[];
  private sessionUsage: TokenUsage = emptyUsage();
  private busy = false;

  constructor(options: AgentOptions) {
    validateConfig(options.config);
    this.client = options.client;
    this.config = Object.freeze({ ...options.config });
    this.historyRepository = options.historyRepository;
    this.history = cloneHistory(this.historyRepository?.load() ?? []);
  }

  async respond(input: string): Promise<AgentResult> {
    const question = input.trim();

    if (question.length === 0) throw new AgentInputError("Запрос не должен быть пустым.");
    if (this.busy) throw new AgentBusyError("Агент уже обрабатывает другой запрос.");

    this.busy = true;

    try {
      let turnUsage = emptyUsage();
      let extraInstruction = STRATEGIES[this.config.strategy];

      if (this.config.strategy === "meta") {
        const preparation = await this.complete(question, META_INSTRUCTION, false);
        turnUsage = addUsage(turnUsage, preparation.usage);
        extraInstruction = requireAnswer(preparation);
      }

      const completion = await this.complete(question, extraInstruction, true);
      turnUsage = addUsage(turnUsage, completion.usage);
      const text = requireAnswer(completion);
      const validation = FORMATS[this.config.format].validate(text);

      const nextHistory: HistoryMessage[] = [
        ...this.history,
        { role: "user", content: question },
        { role: "assistant", content: text },
      ];

      this.historyRepository?.save(cloneHistory(nextHistory));
      this.history = nextHistory;

      return {
        text,
        finishReason: completion.finishReason,
        validation,
        tokenEstimate: {
          questionTokens: estimateTextTokens(question),
          contextTokens: completion.contextTokens,
        },
        usage: {
          finalCall: cloneUsage(completion.usage),
          turn: cloneUsage(turnUsage),
          session: cloneUsage(this.sessionUsage),
        },
      };
    } finally {
      this.busy = false;
    }
  }

  reset(): void {
    if (this.busy) throw new AgentBusyError("Нельзя сбросить агента во время обработки запроса.");

    this.historyRepository?.save([]);
    this.history = [];
    this.sessionUsage = emptyUsage();
  }

  private async complete(
    question: string,
    extraInstruction: string,
    applyOutputPolicy: boolean,
  ): Promise<CompletionResult> {
    const params = this.buildParams(question, extraInstruction, applyOutputPolicy);
    const contextTokens = estimateContextTokens(params.messages);

    if (this.config.maxInputTokens !== null && contextTokens > this.config.maxInputTokens) {
      throw new AgentContextLimitError(
        `Оценка входного контекста ≈ ${contextTokens} токенов превышает установленный лимит ${this.config.maxInputTokens}. ` +
          "Сократите вопрос или очистите историю командой /reset.",
      );
    }

    const response = await this.client.create(params);
    const usage = usageOf(response);

    this.sessionUsage = addUsage(this.sessionUsage, usage);

    const choice = response.choices[0];

    return {
      contextTokens,
      text: choice?.message.content ?? "",
      finishReason: choice?.finish_reason ?? "unknown",
      usage,
    };
  }

  private buildParams(question: string, extraInstruction: string, applyOutputPolicy: boolean): PreparedParams {
    const params: PreparedParams = {
      model: this.config.model,
      messages: [
        { role: "system", content: this.buildSystemPrompt(extraInstruction, applyOutputPolicy) },
        ...this.history,
        { role: "user", content: question },
      ],
    };

    if (this.config.maxTokens !== null) params.max_tokens = this.config.maxTokens;
    if (this.config.temperature !== null) params.temperature = this.config.temperature;
    if (!this.config.thinkingEnabled) params.thinking = { type: "disabled" };

    if (applyOutputPolicy) {
      if (this.config.stopMarker !== null && this.config.format !== "json") params.stop = [this.config.stopMarker];
      if (this.config.format === "json") params.response_format = { type: "json_object" };
    }

    return params;
  }

  private buildSystemPrompt(extraInstruction: string, applyOutputPolicy: boolean): string {
    const blocks = [this.config.systemPrompt, extraInstruction];

    if (applyOutputPolicy) {
      blocks.push(FORMATS[this.config.format].instruction);

      if (this.config.maxWords !== null) blocks.push(`Уложись в ${this.config.maxWords} слов.`);

      if (this.config.stopMarker !== null && this.config.format !== "json") {
        blocks.push(`Закончив ответ, выведи ${this.config.stopMarker} и больше ничего не пиши.`);
      }
    }

    return blocks.filter((block) => block.length > 0).join("\n\n");
  }
}

function cloneHistory(messages: readonly HistoryMessage[]): HistoryMessage[] {
  return messages.map((message) => ({ ...message }));
}

function validateConfig(config: AgentConfig): void {
  if (config.model.trim().length === 0) throw new AgentConfigError("Модель агента не должна быть пустой.");
  if (config.systemPrompt.trim().length === 0) {
    throw new AgentConfigError("Системный промпт агента не должен быть пустым.");
  }
  if (!Object.hasOwn(STRATEGIES, config.strategy)) {
    throw new AgentConfigError(`Неизвестная стратегия: ${config.strategy}.`);
  }
  if (!Object.hasOwn(FORMATS, config.format)) throw new AgentConfigError(`Неизвестный формат: ${config.format}.`);
  assertPositiveInteger(config.maxWords, "maxWords");
  assertPositiveInteger(config.maxTokens, "maxTokens");
  if (config.maxInputTokens !== null && (!Number.isSafeInteger(config.maxInputTokens) || config.maxInputTokens <= 0)) {
    throw new AgentConfigError("maxInputTokens должен быть положительным безопасным целым числом.");
  }

  if (
    config.temperature !== null &&
    (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2)
  ) {
    throw new AgentConfigError("temperature должна быть от 0 до 2.");
  }

  if (config.stopMarker !== null && config.stopMarker.length === 0) {
    throw new AgentConfigError("stopMarker не должен быть пустой строкой.");
  }
}

function assertPositiveInteger(value: number | null, name: string): void {
  if (value !== null && (!Number.isInteger(value) || value <= 0)) {
    throw new AgentConfigError(`${name} должен быть положительным целым числом.`);
  }
}

function usageOf(response: LlmCompletion): TokenUsage {
  const promptTokens = response.usage?.prompt_tokens ?? 0;
  const completionTokens = response.usage?.completion_tokens ?? 0;

  return {
    promptTokens,
    completionTokens,
    reasoningTokens: response.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    totalTokens: response.usage?.total_tokens ?? promptTokens + completionTokens,
  };
}

function requireAnswer(completion: CompletionResult): string {
  if (completion.text.trim().length === 0) {
    throw new AgentResponseError(`LLM вернула пустой ответ (finish_reason: ${completion.finishReason}).`);
  }

  return completion.text;
}

function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 };
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function cloneUsage(usage: TokenUsage): TokenUsage {
  return { ...usage };
}
