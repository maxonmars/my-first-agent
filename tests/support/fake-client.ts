import type { DeepSeekParams, LlmClient, LlmCompletion } from "../../src/llm-client.ts";

type FinishReason = NonNullable<LlmCompletion["choices"][number]["finish_reason"]>;

export interface FakeReply {
  content?: string | null;
  finishReason?: FinishReason;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number | null;
  noChoices?: boolean;
  noUsage?: boolean;
}

export function completionResponse(_params: DeepSeekParams, reply: FakeReply = {}): LlmCompletion {
  const content = reply.content === undefined ? "ответ" : reply.content;
  const promptTokens = reply.promptTokens ?? 0;
  const completionTokens = reply.completionTokens ?? 0;

  return {
    choices: reply.noChoices
      ? []
      : [
          {
            finish_reason: reply.finishReason ?? "stop",
            message: { content },
          },
        ],
    ...(reply.noUsage
      ? {}
      : {
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            ...(reply.totalTokens === null
              ? {}
              : { total_tokens: reply.totalTokens ?? promptTokens + completionTokens }),
            completion_tokens_details: { reasoning_tokens: reply.reasoningTokens ?? 0 },
          },
        }),
  };
}

export function fakeClient(replies: Array<FakeReply | Error>): { client: LlmClient; calls: DeepSeekParams[] } {
  const calls: DeepSeekParams[] = [];
  let index = 0;

  const client: LlmClient = {
    async create(params) {
      calls.push(structuredClone(params));

      const reply = replies[index];
      index += 1;

      if (reply === undefined) throw new Error(`Для вызова ${index} нет заготовленного ответа.`);
      if (reply instanceof Error) throw reply;

      return completionResponse(params, reply);
    },
  };

  return { client, calls };
}

export function systemOf(params: DeepSeekParams): string {
  const first = params.messages[0];

  if (first?.role !== "system" || typeof first.content !== "string") {
    throw new Error("Первым сообщением ожидался системный блок строкой.");
  }

  return first.content;
}
