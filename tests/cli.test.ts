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

  return { respond, reset };
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
