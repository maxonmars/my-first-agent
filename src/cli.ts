import * as readline from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { AgentResult, ContextStatus } from "./agent.ts";
import { MEMORY_LAYERS, type MemoryLayer, type MemorySnapshot, type WritableMemoryLayer } from "./memory.ts";
import { normalizeUserId, PROFILE_FIELDS, type ProfileField, USER_ID_RULE, type UserProfile } from "./profile.ts";

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

/** Агент выбранного пользователя и операции над каталогом профилей. */
export interface SessionPort extends AgentPort {
  getActiveUserId(): string | null;
  loadProfile(userId: string): UserProfile | null;
  initProfile(userId: string, profile: UserProfile): void;
  switchUser(userId: string): void;
  setProfileField(field: ProfileField, value: string): void;
  deleteProfileField(field: ProfileField): boolean;
  clearProfile(): void;
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
  long: "Долговременная память (long) — сведения, предпочтения и знания",
};
const PROFILE_USAGE = {
  load: "/profile load userId",
  set: "/profile set style|constraints|context значение",
  delete: "/profile delete style|constraints|context",
  clear: "/profile clear",
};
const USER_ID_QUESTION = "Укажите идентификатор пользователя, например Макс или Владимир.";
const PROFILE_QUESTIONS: Record<ProfileField, { question: string; hint: string }> = {
  style: {
    question: "Как с вами общаться и оформлять ответы?",
    hint: "обращение, «ты» или «вы», тон, краткость или подробность, простой язык или профессиональные термины, текст, списки, таблицы, примеры",
  },
  constraints: {
    question: "Какие правила соблюдать и чего избегать в ответах?",
    hint: "эмодзи, код без просьбы, ограничения предлагаемых инструментов и решений, уточнения при нехватке информации, обозначение предположений",
  },
  context: {
    question: "Что стоит знать о вас, чтобы ответы были полезнее?",
    hint: "занятие, уровень опыта, привычные инструменты, типичные задачи и долгосрочные цели",
  },
};

/** Черновик опроса /profile-init; userId === null — ещё не введён идентификатор. */
type ProfileWizard = { userId: null } | { userId: string; field: ProfileField; draft: UserProfile };

const RESET_MESSAGE = "Диалог выбранной стратегии и статистика очищены. Рабочая и долговременная память сохранены.\n";
const HELP = [
  "Диалог с агентом. Команды:",
  "  /reset — очистить диалог выбранной стратегии и статистику; рабочая и долговременная память и профиль сохраняются",
  "  /memory — показать все слои памяти",
  ...Object.values(MEMORY_USAGE).map((usage) => `  ${usage}`),
  "  /profile-init — создать или изменить профиль пошаговым опросом и выбрать пользователя",
  "  /profile — показать активного пользователя и профиль",
  ...Object.values(PROFILE_USAGE).map((usage) => `  ${usage}`),
  "  /exit — завершить диалог",
  "Новая задача: /reset, затем /memory clear working.",
  "В branching: /checkpoint, /branch имя, /switch имя, /branches.",
].join("\n");

export async function runCli(agent: SessionPort, args: string[], io: CliIo): Promise<number> {
  writeStatus(io.output, agent);
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

async function runInteractive(agent: SessionPort, io: CliIo): Promise<number> {
  const rl = readline.createInterface({ input: io.input, output: io.output, terminal: false });
  let wizard: ProfileWizard | null = null;

  io.output.write(`${HELP}\n`);
  writePrompt(io.output, agent, wizard);

  for await (const line of rl) {
    const next: ProfileWizard | null | "exit" =
      wizard === null ? await handleLine(agent, line.trim(), io) : stepWizard(agent, wizard, line.trim(), io);
    if (next === "exit") break;
    wizard = next;
    writePrompt(io.output, agent, wizard);
  }

  rl.close();
  return 0;
}

async function handleLine(agent: SessionPort, question: string, io: CliIo): Promise<ProfileWizard | null | "exit"> {
  if (question.length === 0) return null;
  const command = question.split(/\s+/)[0]!.toLowerCase();
  if (command === "/exit") return "exit";

  if (command === "/reset") {
    try {
      agent.reset();
      io.output.write(RESET_MESSAGE);
    } catch (error) {
      io.error.write(`Не удалось сбросить контекст: ${messageOf(error)}\n`);
    }
    return null;
  }

  if (command === "/profile-init") {
    if (question.split(/\s+/).length > 1) {
      io.error.write("Команда не выполнена: Лишние аргументы. Использование: /profile-init\n");
      return null;
    }
    io.output.write("Настройка профиля. /cancel — отменить, /exit — выйти без сохранения.\n");
    io.output.write(`${USER_ID_QUESTION}\n`);
    return { userId: null };
  }

  if (question.startsWith("/")) {
    try {
      if (command === "/memory") runMemoryCommand(agent, question, io.output);
      else if (command === "/profile") runProfileCommand(agent, question, io.output);
      else runBranchCommand(agent, question, io.output);
    } catch (error) {
      io.error.write(`Команда не выполнена: ${messageOf(error)}\n`);
    }
    return null;
  }

  try {
    writeResult(io.output, await agent.respond(question));
  } catch (error) {
    io.error.write(`Запрос не удался: ${messageOf(error)}\n`);
  }
  return null;
}

function stepWizard(
  agent: SessionPort,
  wizard: ProfileWizard,
  answer: string,
  io: CliIo,
): ProfileWizard | null | "exit" {
  const command = answer.toLowerCase();
  if (command === "/exit") return "exit";
  if (command === "/cancel") {
    io.output.write("Настройка профиля отменена, изменения не сохранены.\n");
    return null;
  }
  if (answer.startsWith("/")) {
    io.output.write(
      "Во время настройки профиля команды не выполняются: ответьте на вопрос, /cancel — отменить, /exit — выйти.\n",
    );
    return wizard;
  }

  if (wizard.userId === null) {
    const userId = normalizeUserId(answer);
    if (userId === null) {
      io.error.write(`Неверный ${USER_ID_RULE}.\n${USER_ID_QUESTION}\n`);
      return wizard;
    }
    const existing = agent.loadProfile(userId);
    io.output.write(existing === null ? `Новый профиль «${userId}».\n` : `Изменение профиля «${userId}».\n`);
    return askField(io.output, { userId, field: PROFILE_FIELDS[0], draft: existing ?? {} });
  }

  const draft = answer.length === 0 ? wizard.draft : { ...wizard.draft, [wizard.field]: answer };
  const nextField = PROFILE_FIELDS[PROFILE_FIELDS.indexOf(wizard.field) + 1];
  if (nextField !== undefined) return askField(io.output, { userId: wizard.userId, field: nextField, draft });

  try {
    agent.initProfile(wizard.userId, draft);
  } catch (error) {
    io.error.write(`Профиль не сохранён: ${messageOf(error)}\n`);
    return null;
  }
  io.output.write(`Профиль «${wizard.userId}» сохранён.\n`);
  writeStatus(io.output, agent);
  writeProfile(io.output, agent);
  return null;
}

function askField(output: Writable, wizard: Extract<ProfileWizard, { userId: string }>): ProfileWizard {
  const { question, hint } = PROFILE_QUESTIONS[wizard.field];
  const current = wizard.draft[wizard.field];
  output.write(
    `Профиль «${wizard.userId}», ${PROFILE_FIELDS.indexOf(wizard.field) + 1}/${PROFILE_FIELDS.length} — ${wizard.field}: ${question}\n` +
      `Подсказка: ${hint}.\n` +
      (current === undefined
        ? "Пустой ответ — пропустить группу.\n"
        : `Сейчас: ${current}\nПустой ответ — оставить прежнее значение.\n`),
  );
  return wizard;
}

function runProfileCommand(agent: SessionPort, input: string, output: Writable): void {
  const words = input.split(/\s+/);
  const action = words[1]?.toLowerCase();

  switch (action) {
    case undefined:
      writeProfile(output, agent);
      break;
    case "load": {
      expectWordCount(words, 3, PROFILE_USAGE.load);
      const alreadyActive = agent.getActiveUserId() === words[2];
      agent.switchUser(words[2]!);
      if (alreadyActive) output.write(`Пользователь «${words[2]}» уже выбран.\n`);
      writeStatus(output, agent);
      break;
    }
    case "set": {
      const field = profileField(words[2], PROFILE_USAGE.set);
      if (words.length < 4) throw new Error(`Не хватает аргументов. Использование: ${PROFILE_USAGE.set}`);
      // Значение — весь остаток строки после группы, с внутренними пробелами.
      agent.setProfileField(field, input.replace(/^(?:\S+\s+){3}/, ""));
      output.write(`Группа ${field} сохранена в профиле «${agent.getActiveUserId()}».\n`);
      break;
    }
    case "delete": {
      const field = profileField(words[2], PROFILE_USAGE.delete);
      expectWordCount(words, 3, PROFILE_USAGE.delete);
      output.write(
        agent.deleteProfileField(field)
          ? `Группа ${field} удалена из профиля «${agent.getActiveUserId()}».\n`
          : `Группы ${field} нет в профиле «${agent.getActiveUserId()}».\n`,
      );
      break;
    }
    case "clear":
      expectWordCount(words, 2, PROFILE_USAGE.clear);
      agent.clearProfile();
      output.write(`Профиль «${agent.getActiveUserId()}» очищен. История и память пользователя сохранены.\n`);
      break;
    default:
      throw new Error(
        `Неизвестное действие профиля «${words[1]}». Использование: /profile, ${Object.values(PROFILE_USAGE).join(", ")}`,
      );
  }
}

function profileField(word: string | undefined, usage: string): ProfileField {
  if (word === undefined) throw new Error(`Не указана группа профиля. Использование: ${usage}`);
  const field = PROFILE_FIELDS.find((name) => name === word.toLowerCase());
  if (field === undefined) throw new Error(`Неизвестная группа профиля «${word}». Использование: ${usage}`);
  return field;
}

function writeStatus(output: Writable, agent: SessionPort): void {
  const status = agent.getContextStatus();
  output.write(
    `Пользователь: ${agent.getActiveUserId() ?? "не выбран"}\n` +
      `Контекст: ${status.strategy ?? "без стратегии"}${status.activeBranch === null ? "" : `, ветка: ${status.activeBranch}`}\n`,
  );
}

function writeProfile(output: Writable, agent: SessionPort): void {
  const userId = agent.getActiveUserId();
  if (userId === null) {
    output.write("Пользователь: не выбран. Создайте профиль командой /profile-init.\n");
    return;
  }
  output.write(`Профиль пользователя «${userId}»:\n${JSON.stringify(agent.loadProfile(userId), null, 2)}\n`);
}

function writePrompt(output: Writable, agent: SessionPort, wizard: ProfileWizard | null): void {
  if (wizard === null) output.write(`${agent.getActiveUserId() ?? "без профиля"} > `);
  else output.write(wizard.userId === null ? "профиль > " : `профиль ${wizard.userId} > `);
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
