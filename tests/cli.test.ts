import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { AgentResult } from "../src/agent.ts";
import type { AgentPort, CliIo } from "../src/cli.ts";
import { runCli } from "../src/cli.ts";

function result(text: string, options: { valid?: boolean; total?: number } = {}): AgentResult {
  const total = options.total ?? 7;

  return {
    text,
    finishReason: "stop",
    validation: options.valid === false ? { ok: false, reason: "нарушен контракт" } : { ok: true },
    tokenEstimate: { questionTokens: 2, contextTokens: 30 },
    usage: {
      factsCall: null,
      summaryCall: null,
      finalCall: { promptTokens: 4, completionTokens: 3, reasoningTokens: 2, totalTokens: 7 },
      turn: { promptTokens: 4, completionTokens: 3, reasoningTokens: 2, totalTokens: total },
      session: { promptTokens: 4, completionTokens: 3, reasoningTokens: 2, totalTokens: total },
    },
  };
}

function capture(input = ""): { io: CliIo; output: () => string; error: () => string } {
  let stdout = "";
  let stderr = "";

  const output = new Writable({
    write(chunk, _encoding, callback) {
      stdout += chunk.toString();
      callback();
    },
  });
  const error = new Writable({
    write(chunk, _encoding, callback) {
      stderr += chunk.toString();
      callback();
    },
  });

  return {
    io: { input: Readable.from([input]), output, error },
    output: () => stdout,
    error: () => stderr,
  };
}

function fakeAgent(replies: Array<AgentResult | Error>): AgentPort & {
  respond: ReturnType<typeof vi.fn<AgentPort["respond"]>>;
  reset: ReturnType<typeof vi.fn<AgentPort["reset"]>>;
} {
  let index = 0;
  const respond = vi.fn<AgentPort["respond"]>(async () => {
    const reply = replies[index];
    index += 1;

    if (reply === undefined) throw new Error("Нет ответа fake-агента.");
    if (reply instanceof Error) throw reply;

    return reply;
  });
  const reset = vi.fn<AgentPort["reset"]>();

  return {
    respond,
    reset,
    getContextStatus: () => ({ strategy: "sliding", activeBranch: null }),
    createCheckpoint: vi.fn(),
    createBranch: vi.fn(),
    switchBranch: vi.fn(),
    listBranches: vi.fn(() => [{ name: "main", active: true, messageCount: 0 }]),
  };
}

describe("one-shot CLI", () => {
  it("passes the joined argument to the agent and prints its result and token usage", async () => {
    const agent = fakeAgent([result("готовый ответ", { total: 9 })]);
    const streams = capture();

    const code = await runCli(agent, ["сложный", "вопрос"], streams.io);

    expect(code).toBe(0);
    expect(agent.respond).toHaveBeenCalledWith("сложный вопрос");
    expect(streams.output()).toContain("готовый ответ");
    expect(streams.output()).toContain("ход 9, сессия 9");
    expect(streams.output()).toContain("новый вопрос ≈ 2, весь стек ≈ 30");
    expect(streams.output()).toContain("финальный вызов: вход 4, генерация 3 (из них рассуждение 2)");
    expect(streams.output()).not.toContain("ответ может быть неполным");
    expect(streams.error()).toBe("");
  });

  it("returns failure and prints an agent error without a stack trace", async () => {
    const agent = fakeAgent([new Error("API недоступен")]);
    const streams = capture();

    const code = await runCli(agent, ["вопрос"], streams.io);

    expect(code).toBe(1);
    expect(streams.error()).toBe("Запрос не удался: API недоступен\n");
    expect(streams.error()).not.toContain(" at ");
  });

  it("prints a validation problem returned by the agent", async () => {
    const agent = fakeAgent([result("невалидный ответ", { valid: false })]);
    const streams = capture();

    await runCli(agent, ["вопрос"], streams.io);

    expect(streams.output()).toContain("формат не выдержан: нарушен контракт");
  });
});

describe("interactive CLI", () => {
  it("ignores blank lines, handles reset and stops on exit", async () => {
    const agent = fakeAgent([result("первый ответ"), result("второй ответ")]);
    const streams = capture("\nпервый вопрос\n/reset\nвторой вопрос\n/exit\nлишний вопрос\n");

    const code = await runCli(agent, [], streams.io);

    expect(code).toBe(0);
    expect(agent.respond.mock.calls).toEqual([["первый вопрос"], ["второй вопрос"]]);
    expect(agent.reset).toHaveBeenCalledOnce();
    expect(streams.output()).toContain("Контекст и статистика агента очищены.");
  });

  it("continues the dialog after an agent error", async () => {
    const agent = fakeAgent([new Error("временный сбой"), result("ответ после сбоя")]);
    const streams = capture("первый\nвторой\n/exit\n");

    await runCli(agent, [], streams.io);

    expect(agent.respond).toHaveBeenCalledTimes(2);
    expect(streams.error()).toContain("Запрос не удался: временный сбой");
    expect(streams.output()).toContain("ответ после сбоя");
  });

  it("reports a reset error without claiming success and processes the next input", async () => {
    const agent = fakeAgent([result("ответ после ошибки сброса")]);
    agent.reset.mockImplementationOnce(() => {
      throw new Error("Не удалось сохранить историю: EACCES.");
    });
    const streams = capture("/reset\nследующий вопрос\n/exit\n");

    const code = await runCli(agent, [], streams.io);

    expect(code).toBe(0);
    expect(agent.reset).toHaveBeenCalledOnce();
    expect(streams.error()).toBe("Не удалось сбросить контекст: Не удалось сохранить историю: EACCES.\n");
    expect(streams.output()).not.toContain("Контекст и статистика агента очищены.");
    expect(agent.respond).toHaveBeenCalledWith("следующий вопрос");
    expect(streams.output()).toContain("ответ после ошибки сброса");
  });

  it("prints non-Error failures safely", async () => {
    const agent = fakeAgent([]);
    agent.respond.mockRejectedValueOnce("неизвестный сбой");
    const streams = capture("вопрос\n/exit\n");

    await runCli(agent, [], streams.io);

    expect(streams.error()).toContain("Запрос не удался: неизвестный сбой");
  });
});

it("warns about length without reporting input overflow", async () => {
  const reply = result("частичный ответ");
  reply.finishReason = "length";
  const streams = capture();
  expect(await runCli(fakeAgent([reply]), ["вопрос"], streams.io)).toBe(0);
  expect(streams.output()).toContain("генерация остановилась по лимиту длины; ответ может быть неполным");
  expect(streams.error()).toBe("");
});

it("prints provider facts usage separately from estimates", async () => {
  const response = result("answer");
  response.usage.factsCall = { promptTokens: 12, completionTokens: 3, reasoningTokens: 0, totalTokens: 15 };
  const streams = capture();
  expect(await runCli(fakeAgent([response]), ["question"], streams.io)).toBe(0);
  expect(streams.output()).toContain("API, facts: вход 12, генерация 3, всего 15");
});

it("dispatches branch commands locally, lists the active branch and keeps dialog input separate", async () => {
  const agent = fakeAgent([result("answer")]);
  agent.getContextStatus = () => ({ strategy: "branching", activeBranch: "main" });
  agent.listBranches = () => [
    { name: "main", active: false, messageCount: 2 },
    { name: "a", active: true, messageCount: 4 },
  ];
  const streams = capture("/checkpoint\n/branch a\n/switch main\n/branches\nquestion\n/exit\n");
  await runCli(agent, [], streams.io);
  expect(agent.createCheckpoint).toHaveBeenCalledOnce();
  expect(agent.createBranch).toHaveBeenCalledWith("a");
  expect(agent.switchBranch).toHaveBeenCalledWith("main");
  expect(agent.respond).toHaveBeenCalledExactlyOnceWith("question");
  expect(streams.output()).toContain("Контекст: branching, ветка: main");
  expect(streams.output()).toContain("- main: 2 сообщений");
  expect(streams.output()).toContain("* a: 4 сообщений");
  expect(streams.error()).toBe("");
});

it.each(["/checkpoint extra", "/branch", "/branch a b", "/switch", "/switch a b", "/branches extra", "/unknown"])(
  "reports malformed command %s without calling the LLM",
  async (command) => {
    const agent = fakeAgent([]);
    const streams = capture(`${command}\n/exit\n`);
    await runCli(agent, [], streams.io);
    expect(streams.error()).toContain("Команда не выполнена:");
    expect(agent.respond).not.toHaveBeenCalled();
  },
);

it("reports branch save failure without claiming success and continues", async () => {
  const agent = fakeAgent([result("answer")]);
  agent.createCheckpoint = () => {
    throw new Error("disk");
  };
  const streams = capture("/checkpoint\nquestion\n/exit\n");
  await runCli(agent, [], streams.io);
  expect(streams.error()).toBe("Команда не выполнена: disk\n");
  expect(streams.output()).not.toContain("Checkpoint сохранён");
  expect(agent.respond).toHaveBeenCalledExactlyOnceWith("question");
});

it("prints summary usage in the compression mode", async () => {
  const response = result("answer");
  response.usage.summaryCall = { promptTokens: 12, completionTokens: 3, reasoningTokens: 0, totalTokens: 15 };
  const streams = capture();
  await runCli(fakeAgent([response]), ["question"], streams.io);
  expect(streams.output()).toContain("API, summary: вход 12, генерация 3, всего 15");
});
