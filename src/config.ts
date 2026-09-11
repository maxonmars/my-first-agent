import { z } from "zod";
import type { AgentConfig } from "./agent.ts";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

export const DEFAULT_AGENT_CONFIG: AgentConfig = Object.freeze({
  model: "deepseek-v4-flash",
  systemPrompt: "Ты полезный ассистент. Отвечай кратко и по делу.",
  strategy: "direct",
  format: "text",
  maxWords: null,
  maxTokens: null,
  maxInputTokens: null,
  stopMarker: null,
  temperature: null,
  thinkingEnabled: true,
});

const API_KEY_MESSAGE = "Нет DEEPSEEK_API_KEY. Скопируй .env.example в .env и впиши свой ключ.";

const EnvSchema = z.object({
  DEEPSEEK_API_KEY: z.string(API_KEY_MESSAGE).trim().min(1, API_KEY_MESSAGE),
  DEEPSEEK_MODEL: z.string().optional(),
  AGENT_MAX_INPUT_TOKENS: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed ? Number(trimmed) : null;
    })
    .refine((value) => value === null || (Number.isSafeInteger(value) && value > 0), {
      message: "AGENT_MAX_INPUT_TOKENS должен быть положительным безопасным целым числом.",
    }),
});

export interface AppConfig {
  apiKey: string;
  agent: AgentConfig;
}

export function readConfig(): AppConfig {
  loadEnvFile();

  const result = EnvSchema.safeParse(process.env);

  if (!result.success) {
    throw new Error(result.error.issues[0]?.message ?? "Некорректное окружение.");
  }

  const model = result.data.DEEPSEEK_MODEL?.trim() || DEFAULT_AGENT_CONFIG.model;

  return {
    apiKey: result.data.DEEPSEEK_API_KEY,
    agent: { ...DEFAULT_AGENT_CONFIG, model, maxInputTokens: result.data.AGENT_MAX_INPUT_TOKENS },
  };
}

function loadEnvFile(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
