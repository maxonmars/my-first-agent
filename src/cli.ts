import * as readline from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { AgentResult, ContextStatus } from "./agent.ts";
import { MEMORY_LAYERS, type MemoryLayer, type MemorySnapshot, type WritableMemoryLayer } from "./memory.ts";

export interface AgentPort {
  respond(input: string): Promise<AgentResult>;
  reset(): void;
  getContextStatus(): ContextStatus;
  getMemory(): MemorySnapshot;
  setMemory(layer: WritableMemoryLayer, key: string, value: string): void;
  deleteMemory(layer: WritableMemoryLayer, key: string): boolean;
  clearMemory(layer: MemoryLayer): void;
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

const WRITABLE_MEMORY_LAYERS: readonly WritableMemoryLayer[] = ["working", "long"];
const MEMORY_USAGE = {
  show: "/memory show short|working|long",
  set: "/memory set working|long ключ значение",
  delete: "/memory delete working|long ключ",
  clear: "/memory clear short|working|long",
};
const MEMORY_TITLES: Record<MemoryLayer, string> = {
  short: "Краткосрочная память (short) — состояние диалога выбранной стратегии",
  working: "Рабочая память (working) — условия текущей задачи",
  long: "Долговременная память (long) — профиль, предпочтения и знания",
};
const RESET_MESSAGE = "Диалог выбранной стратегии и статистика очищены. Рабочая и долговременная память сохранены.\n";
const HELP = [
  "Диалог с агентом. Команды:",
  "  /reset — очистить диалог выбранной стратегии и статистику; рабочая и долговременная память сохраняются",
  "  /memory — показать все слои памяти",
  ...Object.values(MEMORY_USAGE).map((usage) => `  ${usage}`),
  "  /exit — завершить диалог",
  "Новая задача: /reset, затем /memory clear working.",
  "В branching: /checkpoint, /branch имя, /switch имя, /branches.",
].join("\n");

export async function runCli(agent: AgentPort, args: string[], io: CliIo): Promise<number> {
  const status = agent.getContextStatus();
  io.output.write(
    `Контекст: ${status.strategy ?? "без стратегии"}${status.activeBranch === null ? "" : `, ветка: ${status.activeBranch}`}\n`,
  );
  const question = args.join(" ").trim();

  if (question.startsWith("/")) {
    io.error.write("Команды доступны только в интерактивном режиме: запустите CLI без аргументов.\n");
    return 1;
  }
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

  io.output.write(`${HELP}\n`);

  for await (const line of rl) {
    const question = line.trim();

    if (question.length === 0) continue;
    if (question.toLowerCase() === "/exit") break;

    if (question.toLowerCase() === "/reset") {
      try {
        agent.reset();
        io.output.write(RESET_MESSAGE);
      } catch (error) {
        io.error.write(`Не удалось сбросить контекст: ${messageOf(error)}\n`);
      }
      continue;
    }

    if (question.startsWith("/")) {
      try {
        if (question.split(/\s+/)[0]!.toLowerCase() === "/memory") runMemoryCommand(agent, question, io.output);
        else runBranchCommand(agent, question, io.output);
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

function runMemoryCommand(agent: AgentPort, input: string, output: Writable): void {
  const words = input.split(/\s+/);
  const action = words[1]?.toLowerCase();

  switch (action) {
    case undefined: {
      const memory = agent.getMemory();
      for (const layer of MEMORY_LAYERS) writeMemoryLayer(output, layer, memory[layer]);
      break;
    }
    case "show": {
      const layer = memoryLayer(words[2], MEMORY_LAYERS, MEMORY_USAGE.show);
      expectWordCount(words, 3, MEMORY_USAGE.show);
      writeMemoryLayer(output, layer, agent.getMemory()[layer]);
      break;
    }
    case "set": {
      const layer = memoryLayer(words[2], WRITABLE_MEMORY_LAYERS, MEMORY_USAGE.set);
      if (words.length < 5) throw new Error(`Не хватает аргументов. Использование: ${MEMORY_USAGE.set}`);
      // Значение — весь остаток строки после ключа, с внутренними пробелами.
      agent.setMemory(layer, words[3]!, input.replace(/^(?:\S+\s+){4}/, ""));
      output.write(`Запись «${words[3]}» сохранена в ${layer}.\n`);
      break;
    }
    case "delete": {
      const layer = memoryLayer(words[2], WRITABLE_MEMORY_LAYERS, MEMORY_USAGE.delete);
      expectWordCount(words, 4, MEMORY_USAGE.delete);
      output.write(
        agent.deleteMemory(layer, words[3]!)
          ? `Запись «${words[3]}» удалена из ${layer}.\n`
          : `Запись «${words[3]}» не найдена в ${layer}.\n`,
      );
      break;
    }
    case "clear": {
      const layer = memoryLayer(words[2], MEMORY_LAYERS, MEMORY_USAGE.clear);
      expectWordCount(words, 3, MEMORY_USAGE.clear);
      agent.clearMemory(layer);
      output.write(layer === "short" ? RESET_MESSAGE : `Слой ${layer} очищен.\n`);
      break;
    }
    default:
      throw new Error(
        `Неизвестное действие памяти «${words[1]}». Использование: /memory, ${Object.values(MEMORY_USAGE).join(", ")}`,
      );
  }
}

function memoryLayer<T extends MemoryLayer>(word: string | undefined, allowed: readonly T[], usage: string): T {
  if (word === undefined) throw new Error(`Не указан слой памяти. Использование: ${usage}`);
  const layer = allowed.find((name) => name === word.toLowerCase());
  if (layer !== undefined) return layer;
  throw new Error(
    word.toLowerCase() === "short"
      ? `Слой short изменяется только диалогом; для записи доступны working и long. Использование: ${usage}`
      : `Неизвестный слой памяти «${word}». Использование: ${usage}`,
  );
}

function expectWordCount(words: string[], count: number, usage: string): void {
  if (words.length !== count) {
    throw new Error(`${words.length < count ? "Не хватает аргументов" : "Лишние аргументы"}. Использование: ${usage}`);
  }
}

function writeMemoryLayer(output: Writable, layer: MemoryLayer, value: MemorySnapshot[MemoryLayer]): void {
  output.write(`${MEMORY_TITLES[layer]}:\n${JSON.stringify(value, null, 2)}\n`);
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
