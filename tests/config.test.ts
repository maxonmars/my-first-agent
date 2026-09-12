import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_CONFIG, readConfig } from "../src/config.ts";

const API_KEY_MESSAGE = "Нет DEEPSEEK_API_KEY. Скопируй .env.example в .env и впиши свой ключ.";
const saved = {
  key: process.env.DEEPSEEK_API_KEY,
  model: process.env.DEEPSEEK_MODEL,
  limit: process.env.AGENT_MAX_INPUT_TOKENS,
};

describe("readConfig", () => {
  beforeEach(() => {
    vi.spyOn(process, "loadEnvFile").mockImplementation(() => {});
    vi.stubEnv("AGENT_HISTORY_COMPRESSION", undefined);
    vi.stubEnv("AGENT_KEEP_LAST_MESSAGES", undefined);
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_MODEL;
    delete process.env.AGENT_MAX_INPUT_TOKENS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    restoreEnv("DEEPSEEK_API_KEY", saved.key);
    restoreEnv("DEEPSEEK_MODEL", saved.model);
    restoreEnv("AGENT_MAX_INPUT_TOKENS", saved.limit);
  });

  it.each([undefined, "", "   "])("disables the input budget for %s", (value) => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    if (value !== undefined) process.env.AGENT_MAX_INPUT_TOKENS = value;
    expect(readConfig().agent.maxInputTokens).toBeNull();
  });

  it.each([" 2000 ", "1", String(Number.MAX_SAFE_INTEGER)])("reads input budget %s", (value) => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    process.env.AGENT_MAX_INPUT_TOKENS = value;
    expect(readConfig().agent.maxInputTokens).toBe(Number(value));
  });

  it.each(["0", "-1", "1.5", "NaN", "Infinity", "abc", "9007199254740992"])("rejects input budget %s", (value) => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    process.env.AGENT_MAX_INPUT_TOKENS = value;
    expect(() => readConfig()).toThrow("AGENT_MAX_INPUT_TOKENS должен быть положительным безопасным целым числом");
  });

  it.each([undefined, "", "   "])("uses compression defaults for %s", (value) => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    vi.stubEnv("AGENT_HISTORY_COMPRESSION", value);
    vi.stubEnv("AGENT_KEEP_LAST_MESSAGES", value);
    expect(readConfig().agent).toMatchObject({ historyCompressionEnabled: true, historyKeepLastMessages: 10 });
  });
  it.each(["true", "false"])("reads compression flag %s", (value) => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    vi.stubEnv("AGENT_HISTORY_COMPRESSION", ` ${value} `);
    vi.stubEnv("AGENT_KEEP_LAST_MESSAGES", " 2 ");
    expect(readConfig().agent).toMatchObject({
      historyCompressionEnabled: value === "true",
      historyKeepLastMessages: 2,
    });
  });
  it.each(["1", "TRUE", "yes"])("rejects invalid compression flag %s", (value) => {
    process.env.DEEPSEEK_API_KEY = "sk-test";
    vi.stubEnv("AGENT_HISTORY_COMPRESSION", value);
    expect(() => readConfig()).toThrow("AGENT_HISTORY_COMPRESSION");
  });
  it.each(["0", "-2", "3", "2.5", "NaN", "Infinity", "abc", "9007199254740992"])(
    "rejects invalid keep count %s",
    (value) => {
      process.env.DEEPSEEK_API_KEY = "sk-test";
      vi.stubEnv("AGENT_KEEP_LAST_MESSAGES", value);
      expect(() => readConfig()).toThrow("AGENT_KEEP_LAST_MESSAGES");
    },
  );

  it("explains how to configure a missing or empty key", () => {
    expect(() => readConfig()).toThrow(API_KEY_MESSAGE);

    process.env.DEEPSEEK_API_KEY = "";

    expect(() => readConfig()).toThrow(API_KEY_MESSAGE);

    process.env.DEEPSEEK_API_KEY = "   ";

    expect(() => readConfig()).toThrow(API_KEY_MESSAGE);
  });

  it("returns the key, requested model and default agent policy", () => {
    process.env.DEEPSEEK_API_KEY = "  sk-test  ";
    process.env.DEEPSEEK_MODEL = "  deepseek-test  ";

    expect(readConfig()).toEqual({
      apiKey: "sk-test",
      agent: { ...DEFAULT_AGENT_CONFIG, model: "deepseek-test" },
    });
  });

  it("uses the default model when the environment value is absent or blank", () => {
    process.env.DEEPSEEK_API_KEY = "sk-test";

    expect(readConfig().agent.model).toBe(DEFAULT_AGENT_CONFIG.model);

    process.env.DEEPSEEK_MODEL = "   ";

    expect(readConfig().agent.model).toBe(DEFAULT_AGENT_CONFIG.model);
  });

  it("allows a missing .env because values can come from the process environment", () => {
    vi.mocked(process.loadEnvFile).mockImplementation(() => {
      throw Object.assign(new Error("file not found"), { code: "ENOENT" });
    });
    process.env.DEEPSEEK_API_KEY = "sk-test";

    expect(readConfig().apiKey).toBe("sk-test");
  });

  it("propagates errors other than a missing .env", () => {
    vi.mocked(process.loadEnvFile).mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });
    process.env.DEEPSEEK_API_KEY = "sk-test";

    expect(() => readConfig()).toThrow("permission denied");
  });
});

function restoreEnv(
  name: "DEEPSEEK_API_KEY" | "DEEPSEEK_MODEL" | "AGENT_MAX_INPUT_TOKENS",
  value: string | undefined,
): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
