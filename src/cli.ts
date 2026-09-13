import * as readline from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { AgentResult, ContextStatus } from "./agent.ts";

export interface AgentPort {
  respond(input: string): Promise<AgentResult>;
  reset(): void;
  getContextStatus(): ContextStatus;
  createCheckpoint(): void;
  createBranch(name: string): void;
  switchBranch(name: string): void;
  listBranches(): Array<{ name: string; active: boolean; messageCount: number }>;
}

export interface CliIo {
  input: Readable;
  output: Writable;
  error: Writable;
}

export async function runCli(agent: AgentPort, args: string[], io: CliIo): Promise<number> {
  const status = agent.getContextStatus();
  io.output.write(
    `Контекст: ${status.strategy ?? "без стратегии"}${status.activeBranch === null ? "" : `, ветка: ${status.activeBranch}`}\n`,
  );
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

  io.output.write(
    "Диалог с агентом. Команды: /reset, /exit. В branching: /checkpoint, /branch имя, /switch имя, /branches.\n",
  );

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

    if (question.startsWith("/")) {
      try {
        runBranchCommand(agent, question, io.output);
      } catch (error) {
        io.error.write(`Команда не выполнена: ${messageOf(error)}\n`);
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

function runBranchCommand(agent: AgentPort, input: string, output: Writable): void {
  const [command, name, ...extra] = input.split(/\s+/);
  switch (command?.toLowerCase()) {
    case "/checkpoint":
      if (name !== undefined) throw new Error("Использование: /checkpoint");
      agent.createCheckpoint();
      output.write("Checkpoint сохранён из активной ветки.\n");
      break;
    case "/branch":
    case "/switch":
      if (name === undefined || extra.length > 0) throw new Error(`Использование: ${command} имя`);
      if (command.toLowerCase() === "/branch") agent.createBranch(name);
      else agent.switchBranch(name);
      output.write(`Активная ветка: ${name}\n`);
      break;
    case "/branches":
      if (name !== undefined) throw new Error("Использование: /branches");
      for (const branch of agent.listBranches()) {
        output.write(`${branch.active ? "*" : "-"} ${branch.name}: ${branch.messageCount} сообщений\n`);
      }
      break;
    default:
      throw new Error(`Неизвестная команда: ${command}`);
  }
}

function writeResult(output: Writable, result: AgentResult): void {
  const { factsCall, summaryCall, finalCall, turn, session } = result.usage;

  output.write(`${result.text}\n`);
  output.write(
    `— оценка токенов: новый вопрос ≈ ${result.tokenEstimate.questionTokens}, весь стек ≈ ${result.tokenEstimate.contextTokens}\n`,
  );
  output.write(
    `— API, финальный вызов: вход ${finalCall.promptTokens}, генерация ${finalCall.completionTokens} ` +
      `(из них рассуждение ${finalCall.reasoningTokens})\n`,
  );
  if (summaryCall !== null) {
    output.write(
      `— API, summary: вход ${summaryCall.promptTokens}, генерация ${summaryCall.completionTokens}, всего ${summaryCall.totalTokens}\n`,
    );
  }
  if (factsCall !== null) {
    output.write(
      `— API, facts: вход ${factsCall.promptTokens}, генерация ${factsCall.completionTokens}, всего ${factsCall.totalTokens}\n`,
    );
  }
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
