import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const mockApi = fileURLToPath(new URL("./support/mock-api.ts", import.meta.url));
const workingDirectory = mkdtempSync(join(tmpdir(), "my-first-agent-e2e-"));

afterAll(() => rmSync(workingDirectory, { recursive: true, force: true }));

describe("CLI process", () => {
  it("explains how to configure a missing API key", () => {
    const env = { ...process.env };
    delete env.DEEPSEEK_API_KEY;
    delete env.DEEPSEEK_MODEL;

    const result = spawnSync(process.execPath, ["--import", mockApi, entry, "вопрос"], {
      cwd: workingDirectory,
      env,
      encoding: "utf8",
      timeout: 20_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Нет DEEPSEEK_API_KEY");
    expect(result.stderr).not.toContain(" at ");
  });

  it("runs the SDK, agent and CLI without a real network request", () => {
    const result = spawnSync(process.execPath, ["--import", mockApi, entry, "проверка связи"], {
      cwd: workingDirectory,
      env: { ...process.env, DEEPSEEK_API_KEY: "sk-test", DEEPSEEK_MODEL: "mock-model" },
      encoding: "utf8",
      timeout: 20_000,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Эхо: проверка связи");
    expect(result.stdout).toContain("ход 8, сессия 8");
    expect(result.stderr).toBe("");
  });
});
