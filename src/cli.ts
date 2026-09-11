import * as readline from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { AgentResult } from "./agent.ts";

export interface AgentPort {
  respond(input: string): Promise<AgentResult>;
  reset(): void;
}

export interface CliIo {
  input: Readable;
  output: Writable;
  error: Writable;
}

export async function runCli(agent: AgentPort, args: string[], io: CliIo): Promise<number> {
  const question = args.join(" ").trim();

  if (question.length > 0) return runOnce(agent, question, io);

  return runInteractive(agent, io);
}

async function runOnce(agent: AgentPort, question: string, io: CliIo): Promise<number> {
  try {
    writeResult(io.output, await agent.respond(question));
    return 0;
  } catch (error) {
    io.error.write(`Запрос не удался: ${messageOf(error)}\n`);
    return 1;
  }
}

async function runInteractive(agent: AgentPort, io: CliIo): Promise<number> {
  const rl = readline.createInterface({ input: io.input, output: io.output, terminal: false });

  io.output.write("Диалог с агентом. Команды: /reset, /exit.\n");

  for await (const line of rl) {
    const question = line.trim();

    if (question.length === 0) continue;
    if (question.toLowerCase() === "/exit") break;

    if (question.toLowerCase() === "/reset") {
      try {
        agent.reset();
        io.output.write("Контекст и статистика агента очищены.\n");
      } catch (error) {
        io.error.write(`Не удалось сбросить контекст: ${messageOf(error)}\n`);
      }
      continue;
    }

    try {
      writeResult(io.output, await agent.respond(question));
    } catch (error) {
      io.error.write(`Запрос не удался: ${messageOf(error)}\n`);
    }
  }

  rl.close();
  return 0;
}

function writeResult(output: Writable, result: AgentResult): void {
  const { finalCall, turn, session } = result.usage;

  output.write(`${result.text}\n`);
  output.write(
    `— оценка токенов: новый вопрос ≈ ${result.tokenEstimate.questionTokens}, весь стек ≈ ${result.tokenEstimate.contextTokens}\n`,
  );
  output.write(
    `— API, финальный вызов: вход ${finalCall.promptTokens}, генерация ${finalCall.completionTokens} ` +
      `(из них рассуждение ${finalCall.reasoningTokens})\n`,
  );
  output.write(`— расход токенов: ход ${turn.totalTokens}, сессия ${session.totalTokens}\n`);

  if (result.finishReason === "length") {
    output.write("— генерация остановилась по лимиту длины; ответ может быть неполным.\n");
  }

  if (!result.validation.ok)
    output.write(`— формат не выдержан: ${result.validation.reason ?? "неизвестная причина"}\n`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
