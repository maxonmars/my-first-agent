import * as readline from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { AgentResult, ContextStatus } from "./agent.ts";
import {
  type HelpGroup,
  printAnswer,
  printBranches,
  printError,
  printHelp,
  printInvariants,
  printMemoryLayer,
  printNotice,
  printProfile,
  printProfileIntro,
  printProfileList,
  printProfileStep,
  printPrompt,
  printSession,
  printSuccess,
  printTask,
  printTaskState,
  printWarning,
} from "./cli-view.ts";
import type { InvariantInfo } from "./invariants.ts";
import { MEMORY_LAYERS, type MemoryLayer, type MemorySnapshot, type WritableMemoryLayer } from "./memory.ts";
import {
  type AgentProfile,
  normalizeProfileId,
  PROFILE_FIELDS,
  PROFILE_ID_RULE,
  type ProfileField,
} from "./profile.ts";
import type { TaskView } from "./task.ts";

export interface AgentPort {
  respond(input: string): Promise<AgentResult>;
  reset(): void;
  getContextStatus(): ContextStatus;
  getInvariants(): InvariantInfo[];
  getMemory(): MemorySnapshot;
  setMemory(layer: WritableMemoryLayer, key: string, value: string): void;
  deleteMemory(layer: WritableMemoryLayer, key: string): boolean;
  clearMemory(layer: MemoryLayer): void;
  createCheckpoint(): void;
  createBranch(name: string): void;
  switchBranch(name: string): void;
  listBranches(): Array<{ name: string; active: boolean; messageCount: number }>;
  getTask(): TaskView | null;
  startTask(description: string): void;
  approveTask(): void;
  pauseTask(): boolean;
  resumeTask(): boolean;
  clearTask(): boolean;
}

/** Агент с общей памятью и операции над каталогом его профилей. */
export interface SessionPort extends AgentPort {
  getActiveProfileId(): string | null;
  listProfileIds(): readonly string[];
  loadProfile(profileId: string): AgentProfile | null;
  initProfile(profileId: string, profile: AgentProfile): void;
  switchProfile(profileId: string): void;
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
const TASK_USAGE = {
  start: "/task start описание",
  approve: "/task approve",
  pause: "/task pause",
  resume: "/task resume",
  clear: "/task clear",
};
const PROFILE_USAGE = {
  list: "/profile list",
  load: "/profile load profileId",
  set: "/profile set style|constraints|context значение",
  delete: "/profile delete style|constraints|context",
  clear: "/profile clear",
};
const PROFILE_ID_QUESTION = "Укажите идентификатор профиля агента, например аналитик, автор или редактор.";
const PROFILE_QUESTIONS: Record<ProfileField, { question: string; hint: string }> = {
  style: {
    question: "Как агент должен общаться и оформлять результат?",
    hint: "тон, краткость или подробность, простой язык или термины, текст, списки, таблицы, структура результата",
  },
  constraints: {
    question: "Какие правила агент должен соблюдать и чего избегать при работе?",
    hint: "что не добавлять и не менять, как обозначать предположения, когда уточнять, границы роли",
  },
  context: {
    question: "Какую роль выполняет агент, в какой области и на каких задачах специализируется?",
    hint: "роль, предметная область, типичные задачи и критерии качества результата",
  },
};

/** Черновик опроса /profile-init; profileId === null — ещё не введён идентификатор. */
type ProfileWizard = { profileId: null } | { profileId: string; field: ProfileField; draft: AgentProfile };

const HELP: readonly HelpGroup[] = [
  {
    title: "Диалог",
    lines: [
      "Реплика без / уходит агенту: в задачу или в обычный чат — это видно по приглашению.",
      ["/help", "показать эту справку"],
      [
        "/reset",
        "очистить историю выбранной стратегии и статистику; рабочая и долговременная память, профили и задача сохраняются",
      ],
      ["/exit", "завершить диалог"],
      "Новый разговор: /reset, затем /memory clear working — рабочая память очищается отдельно.",
      "Задачу удаляет только /task clear.",
    ],
  },
  {
    title: "Задача",
    lines: [
      ["/task", "показать описание, план, результаты, проверку, вопрос агента и следующее действие"],
      [TASK_USAGE.start, "создать задачу; модель начнёт работу со следующей реплики"],
      [TASK_USAGE.approve, "утвердить предложенный план и перейти к выполнению"],
      [TASK_USAGE.pause, "приостановить задачу: реплики пойдут в обычный чат"],
      [TASK_USAGE.resume, "вернуть реплики в задачу"],
      [TASK_USAGE.clear, "удалить задачу; /reset её не удаляет"],
    ],
  },
  {
    title: "Память",
    lines: [
      ["/memory", "показать все слои памяти"],
      [MEMORY_USAGE.show, "показать один слой"],
      [MEMORY_USAGE.set, "создать или заменить запись; значение — остаток строки"],
      [MEMORY_USAGE.delete, "удалить запись"],
      [MEMORY_USAGE.clear, "очистить слой; clear short — то же, что /reset"],
    ],
  },
  {
    title: "Профиль",
    lines: [
      "Профиль агента — роль, ограничения и стиль; история, память и задача общие для всех профилей.",
      ["/profile-init", "создать или изменить профиль агента пошаговым опросом и выбрать его"],
      ["/profile", "показать активный профиль"],
      [PROFILE_USAGE.list, "показать сохранённые профили и отметить активный"],
      [PROFILE_USAGE.load, "выбрать существующий профиль; действует со следующего ответа"],
      [PROFILE_USAGE.set, "заменить группу профиля; значение — остаток строки"],
      [PROFILE_USAGE.delete, "удалить группу профиля"],
      [PROFILE_USAGE.clear, "очистить настройки активного профиля; общие история, память и задача сохраняются"],
    ],
  },
  {
    title: "Инварианты",
    lines: [
      "Обязательные правила ответа: общие для всех профилей, режимов, веток и задач; команды их не меняют.",
      ["/invariants", "показать активные инварианты"],
    ],
  },
  {
    title: "Ветки",
    lines: [
      "Только в режиме branching: AGENT_CONTEXT_STRATEGY=branching.",
      ["/checkpoint", "сохранить снимок активной ветки"],
      ["/branch имя", "создать ветку из checkpoint и сделать её активной"],
      ["/switch имя", "перейти в существующую ветку"],
      ["/branches", "показать ветки, число сообщений и активную ветку"],
    ],
  },
];

export async function runCli(agent: SessionPort, args: string[], io: CliIo): Promise<number> {
  const question = args.join(" ").trim();
  writeStatus(io.output, agent, { title: true, commandsHint: question.length === 0 });

  if (question.startsWith("/")) {
    printError(io.error, "Команды доступны только в интерактивном режиме: запустите CLI без аргументов.");
    return 1;
  }
  if (question.length > 0) return runOnce(agent, question, io);

  return runInteractive(agent, io);
}

async function runOnce(agent: AgentPort, question: string, io: CliIo): Promise<number> {
  try {
    printAnswer(io.output, await agent.respond(question));
    writeTaskTurnStatus(io.output, agent);
    return 0;
  } catch (error) {
    printError(io.error, `Запрос не удался: ${messageOf(error)}`);
    return 1;
  }
}

async function runInteractive(agent: SessionPort, io: CliIo): Promise<number> {
  const rl = readline.createInterface({ input: io.input, output: io.output, terminal: false });
  let wizard: ProfileWizard | null = null;

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
      writeReset(io.output, agent);
    } catch (error) {
      printError(io.error, `Не удалось сбросить контекст: ${messageOf(error)}`);
    }
    return null;
  }

  if (command === "/profile-init") {
    if (question.split(/\s+/).length > 1) {
      printError(io.error, "Команда не выполнена: Лишние аргументы. Использование: /profile-init");
      return null;
    }
    printProfileIntro(io.output, PROFILE_ID_QUESTION);
    return { profileId: null };
  }

  if (question.startsWith("/")) {
    try {
      if (command === "/help") runHelpCommand(question, io.output);
      else if (command === "/invariants") runInvariantsCommand(agent, question, io.output);
      else if (command === "/memory") runMemoryCommand(agent, question, io.output);
      else if (command === "/profile") runProfileCommand(agent, question, io.output);
      else if (command === "/task") runTaskCommand(agent, question, io.output);
      else runBranchCommand(agent, question, io.output);
    } catch (error) {
      printError(io.error, `Команда не выполнена: ${messageOf(error)}`);
    }
    return null;
  }

  try {
    printAnswer(io.output, await agent.respond(question));
    writeTaskTurnStatus(io.output, agent);
  } catch (error) {
    printError(io.error, `Запрос не удался: ${messageOf(error)}`);
  }
  return null;
}

function runHelpCommand(input: string, output: Writable): void {
  expectWordCount(input.split(/\s+/), 1, "/help");
  printHelp(output, HELP);
}

function runInvariantsCommand(agent: AgentPort, input: string, output: Writable): void {
  expectWordCount(input.split(/\s+/), 1, "/invariants");
  printInvariants(output, agent.getInvariants());
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
    printNotice(io.output, "Настройка профиля отменена, изменения не сохранены.");
    return null;
  }
  if (answer.startsWith("/")) {
    printWarning(
      io.output,
      "Во время настройки профиля команды не выполняются: ответьте на вопрос, /cancel — отменить, /exit — выйти.",
    );
    return wizard;
  }

  if (wizard.profileId === null) {
    const profileId = normalizeProfileId(answer);
    if (profileId === null) {
      printError(io.error, `Неверный ${PROFILE_ID_RULE}.`);
      printNotice(io.error, PROFILE_ID_QUESTION);
      return wizard;
    }
    const existing = agent.loadProfile(profileId);
    printNotice(io.output, existing === null ? `Новый профиль «${profileId}».` : `Изменение профиля «${profileId}».`);
    return askField(io.output, { profileId, field: PROFILE_FIELDS[0], draft: existing ?? {} });
  }

  const draft = answer.length === 0 ? wizard.draft : { ...wizard.draft, [wizard.field]: answer };
  const nextField = PROFILE_FIELDS[PROFILE_FIELDS.indexOf(wizard.field) + 1];
  if (nextField !== undefined) return askField(io.output, { profileId: wizard.profileId, field: nextField, draft });

  try {
    agent.initProfile(wizard.profileId, draft);
  } catch (error) {
    printError(io.error, `Профиль не сохранён: ${messageOf(error)}`);
    return null;
  }
  printSuccess(io.output, `Профиль «${wizard.profileId}» сохранён.`);
  writeStatus(io.output, agent);
  writeProfile(io.output, agent);
  return null;
}

function askField(output: Writable, wizard: Extract<ProfileWizard, { profileId: string }>): ProfileWizard {
  printProfileStep(output, {
    profileId: wizard.profileId,
    position: PROFILE_FIELDS.indexOf(wizard.field) + 1,
    total: PROFILE_FIELDS.length,
    field: wizard.field,
    ...PROFILE_QUESTIONS[wizard.field],
    current: wizard.draft[wizard.field],
  });
  return wizard;
}

function runProfileCommand(agent: SessionPort, input: string, output: Writable): void {
  const words = input.split(/\s+/);
  const action = words[1]?.toLowerCase();

  switch (action) {
    case undefined:
      writeProfile(output, agent);
      break;
    case "list":
      expectWordCount(words, 2, PROFILE_USAGE.list);
      printProfileList(output, agent.listProfileIds(), agent.getActiveProfileId());
      break;
    case "load": {
      expectWordCount(words, 3, PROFILE_USAGE.load);
      const alreadyActive = agent.getActiveProfileId() === words[2];
      agent.switchProfile(words[2]!);
      if (alreadyActive) printNotice(output, `Профиль «${words[2]}» уже выбран.`);
      writeStatus(output, agent);
      break;
    }
    case "set": {
      const field = profileField(words[2], PROFILE_USAGE.set);
      if (words.length < 4) throw new Error(`Не хватает аргументов. Использование: ${PROFILE_USAGE.set}`);
      // Значение — весь остаток строки после группы, с внутренними пробелами.
      agent.setProfileField(field, input.replace(/^(?:\S+\s+){3}/, ""));
      printSuccess(output, `Группа ${field} сохранена в профиле «${agent.getActiveProfileId()}».`);
      break;
    }
    case "delete": {
      const field = profileField(words[2], PROFILE_USAGE.delete);
      expectWordCount(words, 3, PROFILE_USAGE.delete);
      if (agent.deleteProfileField(field)) {
        printSuccess(output, `Группа ${field} удалена из профиля «${agent.getActiveProfileId()}».`);
      } else printNotice(output, `Группы ${field} нет в профиле «${agent.getActiveProfileId()}».`);
      break;
    }
    case "clear":
      expectWordCount(words, 2, PROFILE_USAGE.clear);
      agent.clearProfile();
      printSuccess(
        output,
        `Профиль «${agent.getActiveProfileId()}» очищен.`,
        "Общие история, память и задача сохранены.",
      );
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

/** Профиль, контекст и задача с черновиком плана и открытым вопросом. */
function writeStatus(
  output: Writable,
  agent: SessionPort,
  header: { title?: boolean; commandsHint?: boolean } = {},
): void {
  printSession(output, agent.getActiveProfileId(), agent.getContextStatus(), header);
  const task = agent.getTask();
  if (task !== null) printTaskState(output, task, { plan: true, question: true });
}

function writeProfile(output: Writable, agent: SessionPort): void {
  const profileId = agent.getActiveProfileId();
  if (profileId === null) {
    printNotice(output, "Профиль не выбран: работа без профиля. Создайте профиль командой /profile-init.");
    return;
  }
  printProfile(output, profileId, agent.loadProfile(profileId));
}

function writePrompt(output: Writable, agent: SessionPort, wizard: ProfileWizard | null): void {
  if (wizard === null) {
    const task = agent.getTask();
    const target = task === null ? "" : task.status.paused ? " [чат, задача на паузе]" : " [задача]";
    printPrompt(output, `${agent.getActiveProfileId() ?? "без профиля"}${target}`);
  } else printPrompt(output, wizard.profileId === null ? "профиль" : `профиль ${wizard.profileId}`);
}

function runMemoryCommand(agent: AgentPort, input: string, output: Writable): void {
  const words = input.split(/\s+/);
  const action = words[1]?.toLowerCase();

  switch (action) {
    case undefined: {
      const memory = agent.getMemory();
      for (const layer of MEMORY_LAYERS) printMemoryLayer(output, layer, memory[layer]);
      break;
    }
    case "show": {
      const layer = memoryLayer(words[2], MEMORY_LAYERS, MEMORY_USAGE.show);
      expectWordCount(words, 3, MEMORY_USAGE.show);
      printMemoryLayer(output, layer, agent.getMemory()[layer]);
      break;
    }
    case "set": {
      const layer = memoryLayer(words[2], WRITABLE_MEMORY_LAYERS, MEMORY_USAGE.set);
      if (words.length < 5) throw new Error(`Не хватает аргументов. Использование: ${MEMORY_USAGE.set}`);
      // Значение — весь остаток строки после ключа, с внутренними пробелами.
      agent.setMemory(layer, words[3]!, input.replace(/^(?:\S+\s+){4}/, ""));
      printSuccess(output, `Запись «${words[3]}» сохранена в ${layer}.`);
      break;
    }
    case "delete": {
      const layer = memoryLayer(words[2], WRITABLE_MEMORY_LAYERS, MEMORY_USAGE.delete);
      expectWordCount(words, 4, MEMORY_USAGE.delete);
      if (agent.deleteMemory(layer, words[3]!)) printSuccess(output, `Запись «${words[3]}» удалена из ${layer}.`);
      else printNotice(output, `Запись «${words[3]}» не найдена в ${layer}.`);
      break;
    }
    case "clear": {
      const layer = memoryLayer(words[2], MEMORY_LAYERS, MEMORY_USAGE.clear);
      expectWordCount(words, 3, MEMORY_USAGE.clear);
      agent.clearMemory(layer);
      if (layer === "short") writeReset(output, agent);
      else printSuccess(output, `Слой ${layer} очищен.`);
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

function writeReset(output: Writable, agent: AgentPort): void {
  printSuccess(
    output,
    "Диалог выбранной стратегии и статистика очищены.",
    "Рабочая и долговременная память сохранены.",
  );
  if (agent.getTask() !== null) printNotice(output, "Задача не изменена: удалить её можно командой /task clear.");
}

function runTaskCommand(agent: AgentPort, input: string, output: Writable): void {
  const words = input.split(/\s+/);
  const action = words[1]?.toLowerCase();

  switch (action) {
    case undefined: {
      const task = agent.getTask();
      if (task === null) printNotice(output, `Задачи нет. Создайте её командой ${TASK_USAGE.start}.`);
      else printTask(output, task);
      return;
    }
    case "start":
      if (words.length < 3) throw new Error(`Не хватает аргументов. Использование: ${TASK_USAGE.start}`);
      // Описание — остаток строки после подкоманды, с исходным регистром и внутренними пробелами.
      agent.startTask(input.replace(/^(?:\S+\s+){2}/, ""));
      printSuccess(output, "Задача создана.", "Модель начнёт работу по следующей реплике, например «Продолжай».");
      break;
    case "approve":
      expectWordCount(words, 2, TASK_USAGE.approve);
      agent.approveTask();
      printSuccess(output, "План утверждён.", "Первый шаг выполнится по следующей реплике, например «Продолжай».");
      break;
    case "pause":
      expectWordCount(words, 2, TASK_USAGE.pause);
      if (agent.pauseTask()) {
        printSuccess(
          output,
          "Задача приостановлена.",
          "Реплики идут в обычный чат; /task resume — вернуться к задаче.",
        );
      } else printNotice(output, "Задача уже на паузе.");
      break;
    case "resume": {
      expectWordCount(words, 2, TASK_USAGE.resume);
      if (agent.resumeTask()) printSuccess(output, "Задача возобновлена.", "Реплики снова идут в задачу.");
      else printNotice(output, "Задача уже активна.");
      const resumed = agent.getTask();
      if (resumed !== null) printTaskState(output, resumed, { plan: true, question: true });
      return;
    }
    case "clear":
      expectWordCount(words, 2, TASK_USAGE.clear);
      if (agent.clearTask()) printSuccess(output, "Задача удалена.", "Обычный диалог, профиль и память сохранены.");
      else printNotice(output, "Задачи нет, удалять нечего.");
      return;
    default:
      throw new Error(
        `Неизвестное действие задачи «${words[1]}». Использование: /task, ${Object.values(TASK_USAGE).join(", ")}`,
      );
  }
  const task = agent.getTask();
  if (task !== null) printTaskState(output, task);
}

/** Задача без паузы после ответа означает, что ход относился к ней. */
function writeTaskTurnStatus(output: Writable, agent: AgentPort): void {
  const task = agent.getTask();
  if (task !== null && !task.status.paused) printTaskState(output, task, { plan: true });
}

function runBranchCommand(agent: AgentPort, input: string, output: Writable): void {
  const [command, name, ...extra] = input.split(/\s+/);
  switch (command?.toLowerCase()) {
    case "/checkpoint":
      if (name !== undefined) throw new Error("Использование: /checkpoint");
      agent.createCheckpoint();
      printSuccess(output, "Checkpoint сохранён из активной ветки.");
      break;
    case "/branch":
    case "/switch":
      if (name === undefined || extra.length > 0) throw new Error(`Использование: ${command} имя`);
      if (command.toLowerCase() === "/branch") agent.createBranch(name);
      else agent.switchBranch(name);
      printSuccess(output, `Активная ветка: ${name}`);
      break;
    case "/branches":
      if (name !== undefined) throw new Error("Использование: /branches");
      printBranches(output, agent.listBranches());
      break;
    default:
      throw new Error(`Неизвестная команда: ${command}`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
