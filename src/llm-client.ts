import type OpenAI from "openai";

export type DeepSeekParams = OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & {
  thinking?: { type: "disabled" };
};

export interface LlmCompletion {
  choices: Array<{
    message: { content: string | null };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

export interface LlmClient {
  create(params: DeepSeekParams): Promise<LlmCompletion>;
}
