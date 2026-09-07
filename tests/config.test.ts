import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_CONFIG, readConfig } from "../src/config.ts";

const API_KEY_MESSAGE = "Нет DEEPSEEK_API_KEY. Скопируй .env.example в .env и впиши свой ключ.";
const saved = { key: process.env.DEEPSEEK_API_KEY, model: process.env.DEEPSEEK_MODEL };

describe("readConfig", () => {
  beforeEach(() => {
    vi.spyOn(process, "loadEnvFile").mockImplementation(() => {});
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_MODEL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnv("DEEPSEEK_API_KEY", saved.key);
    restoreEnv("DEEPSEEK_MODEL", saved.model);
  });

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

function restoreEnv(name: "DEEPSEEK_API_KEY" | "DEEPSEEK_MODEL", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
