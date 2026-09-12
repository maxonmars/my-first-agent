import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const mockApi = fileURLToPath(new URL("./support/mock-api.ts", import.meta.url));
let workingDirectory: string;
let historyPath: string;

beforeEach(() => {
  workingDirectory = mkdtempSync(join(tmpdir(), "my-first-agent-e2e-"));
  historyPath = join(workingDirectory, ".agent-history.json");
});

afterEach(() => rmSync(workingDirectory, { recursive: true, force: true }));

function runProcess(args: string[], input?: string, env = process.env) {
  return spawnSync(process.execPath, ["--import", mockApi, entry, ...args], {
    cwd: workingDirectory,
    env,
    input,
    encoding: "utf8",
    timeout: 20_000,
  });
}

function mockEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DEEPSEEK_API_KEY: "sk-test",
    DEEPSEEK_MODEL: "mock-model",
    AGENT_HISTORY_COMPRESSION: "true",
    AGENT_KEEP_LAST_MESSAGES: "10",
    AGENT_MAX_INPUT_TOKENS: "",
  };
}

function readHistory(): unknown {
  return JSON.parse(readFileSync(historyPath, "utf8"));
}

describe("CLI process", () => {
  it("explains how to configure a missing API key", () => {
    const env = { ...process.env };
    delete env.DEEPSEEK_API_KEY;
    delete env.DEEPSEEK_MODEL;

    const result = runProcess(["вопрос"], undefined, env);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Нет DEEPSEEK_API_KEY");
    expect(result.stderr).not.toContain(" at ");
  });

  it("runs the SDK, agent and CLI without a real network request", () => {
    const result = runProcess(["проверка связи"], undefined, mockEnvironment());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Эхо: проверка связи");
    expect(result.stdout).toContain("ход 8, сессия 8");
    expect(result.stderr).toBe("");
    expect(readHistory()).toEqual({
      summary: null,
      messages: [
        { role: "user", content: "проверка связи" },
        { role: "assistant", content: "Эхо: проверка связи" },
      ],
    });
  });

  it("restores an interactive turn in a new one-shot process and starts token usage from zero", () => {
    const first = runProcess([], "Меня зовут Максим\n/exit\n", mockEnvironment());

    expect(first.status).toBe(0);
    expect(first.stdout).toContain("Эхо: Меня зовут Максим");
    expect(first.stderr).toBe("");

    const second = runProcess(["Как меня зовут?"], undefined, mockEnvironment());

    expect(second.status).toBe(0);
    expect(second.stdout).toContain("Вас зовут Максим.");
    expect(second.stdout).toContain("ход 8, сессия 8");
    expect(second.stderr).toBe("");
    expect(readHistory()).toEqual({
      summary: null,
      messages: [
        { role: "user", content: "Меня зовут Максим" },
        { role: "assistant", content: "Эхо: Меня зовут Максим" },
        { role: "user", content: "Как меня зовут?" },
        { role: "assistant", content: "Вас зовут Максим." },
      ],
    });
  });

  it("keeps an empty history file after reset and sends no old context after restart", () => {
    const first = runProcess([], "Меня зовут Максим\n/reset\n/exit\n", mockEnvironment());

    expect(first.status).toBe(0);
    expect(first.stdout).toContain("Контекст и статистика агента очищены.");
    expect(first.stderr).toBe("");
    expect(readHistory()).toEqual({ summary: null, messages: [] });

    const second = runProcess(["Есть ли предыдущий контекст?"], undefined, mockEnvironment());

    expect(second.status).toBe(0);
    expect(second.stdout).toContain("Предыдущих сообщений нет.");
    expect(second.stderr).toBe("");
    expect(readHistory()).toEqual({
      summary: null,
      messages: [
        { role: "user", content: "Есть ли предыдущий контекст?" },
        { role: "assistant", content: "Предыдущих сообщений нет." },
      ],
    });
  });

  it("fails startup with a corrupted history file and leaves its contents unchanged", () => {
    const corrupted = '[{"role":"user","content":"личный текст"}';
    writeFileSync(historyPath, corrupted, "utf8");

    const result = runProcess(["вопрос"], undefined, mockEnvironment());

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(historyPath);
    expect(result.stderr).toContain("некорректный JSON");
    expect(result.stderr).not.toContain("личный текст");
    expect(result.stderr).not.toContain(" at ");
    expect(readFileSync(historyPath, "utf8")).toBe(corrupted);
  });
});

it("blocks growing history locally and recovers through interactive reset", () => {
  const env = { ...mockEnvironment(), AGENT_MAX_INPUT_TOKENS: "17" };
  const result = runProcess([], "abcd\nabcd\nabcd\n/reset\nabcd\n/exit\n", env);
  expect(result.status).toBe(0);
  expect(result.stdout.match(/Эхо: abcd/g)).toHaveLength(3);
  expect(result.stdout.match(/новый вопрос ≈ 1, весь стек ≈ 13/g)).toHaveLength(2);
  expect(result.stdout).toContain("новый вопрос ≈ 1, весь стек ≈ 17");
  expect(result.stderr).toContain("≈ 21 токенов превышает установленный лимит 17");
  expect(result.stdout).toContain("ход 8, сессия 16");
  expect(result.stdout.split("Контекст и статистика агента очищены.")[1]).toContain("ход 8, сессия 8");
  expect(readHistory()).toEqual({
    summary: null,
    messages: [
      { role: "user", content: "abcd" },
      { role: "assistant", content: "Эхо: abcd" },
    ],
  });
  const beforeRefusal = readFileSync(historyPath, "utf8");
  const blocked = runProcess(["x".repeat(100)], undefined, env);
  expect(blocked.status).toBe(1);
  expect(blocked.stdout).toBe("");
  expect(blocked.stderr).toContain("превышает установленный лимит 17");
  expect(readFileSync(historyPath, "utf8")).toBe(beforeRefusal);
});

it("persists compressed state and restores summary and tail in a new process", () => {
  const env = mockEnvironment();
  const first = runProcess([], `${Array.from({ length: 11 }, (_, i) => `ход ${i + 1}`).join("\n")}\n/exit\n`, env);
  expect(first.status).toBe(0);
  expect(first.stdout).toContain("API, summary:");
  const compressed = JSON.parse(readFileSync(historyPath, "utf8"));
  expect(compressed.summary).toBe("Факт из первых пяти ходов.");
  expect(compressed.messages).toHaveLength(12);
  expect(compressed.messages[0]).toEqual({ role: "user", content: "ход 6" });
  const second = runProcess(["Проверь восстановленное summary"], undefined, {
    ...env,
    AGENT_HISTORY_COMPRESSION: "false",
  });
  expect(second.status).toBe(0);
  expect(second.stdout).toContain("Summary и хвост восстановлены.");
  expect(second.stdout).toContain("ход 8, сессия 8");
  const reset = runProcess([], "/reset\n/exit\n", env);
  expect(reset.status).toBe(0);
  expect(readHistory()).toEqual({ summary: null, messages: [] });
});
