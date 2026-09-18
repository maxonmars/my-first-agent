import type { Writable } from "node:stream";
import { styleText } from "node:util";
import type { AgentResult, ContextStatus, TokenUsage } from "./agent.ts";
import type { InvariantInfo } from "./invariants.ts";
import type { MemoryEntries, MemoryLayer, MemorySnapshot } from "./memory.ts";
import type { AgentProfile } from "./profile.ts";
import type { TaskContext, TaskState, TaskView } from "./task.ts";

type Tone = "heading" | "user" | "action" | "success" | "error" | "errorLabel" | "muted" | "key" | "doneKey";

const STYLES: Record<Tone, Parameters<typeof styleText>[0]> = {
  heading: ["cyan", "bold"],
  user: "magenta",
  action: "yellow",
  success: "green",
  error: "red",
  errorLabel: ["red", "bold"],
  muted: "gray",
  key: "bold",
  doneKey: ["green", "bold"],
};

const STATE_TITLES: Record<TaskState, string> = {
  planning: "Планирование",
  execution: "Выполнение",
  validation: "Проверка результатов",
  done: "Завершена",
};

const MEMORY_TITLES: Record<MemoryLayer, { title: string; subtitle: string }> = {
  short: { title: "Краткосрочная память (short)", subtitle: "Состояние диалога выбранной стратегии." },
  working: { title: "Рабочая память (working)", subtitle: "Условия текущей задачи." },
  long: { title: "Долговременная память (long)", subtitle: "Сведения, предпочтения и знания." },
};

/** Строка справки: пара «синтаксис — описание» или пояснение. */
export type HelpLine = readonly [usage: string, description: string] | string;

export interface HelpGroup {
  title: string;
  lines: readonly HelpLine[];
}

export interface ProfileStep {
  profileId: string;
  position: number;
  total: number;
  field: string;
  question: string;
  hint: string;
  current: string | undefined;
}

/** Цвет решает styleText отдельно для каждого потока: TTY, NO_COLOR, NODE_DISABLE_COLORS, FORCE_COLOR. */
function paint(stream: Writable, tone: Tone, text: string): string {
  return text.length === 0 ? text : styleText(STYLES[tone], text, { stream });
}

/** Группировка разрядов и для четырёхзначных чисел: локаль ru по умолчанию оставляет 1594 без пробела. */
export function formatCount(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** Блок начинается с пустой строки: так он отделён от введённой реплики и предыдущего блока. */
function printBlock(stream: Writable, title: string, lines: readonly string[]): void {
  const body = lines.join("\n");
  stream.write(`\n${paint(stream, "heading", `── ${title} ──`)}\n\n${body.endsWith("\n") ? body : `${body}\n`}`);
}

export function printSession(
  output: Writable,
  profileId: string | null,
  context: ContextStatus,
  options: { title?: boolean; commandsHint?: boolean } = {},
): void {
  if (options.title) output.write(`${paint(output, "heading", "── my-first-agent ──")}\n\n`);
  const branch = context.activeBranch === null ? "" : `, ветка: ${context.activeBranch}`;
  output.write(
    `${paint(output, "muted", "Профиль:")} ${paint(output, "user", profileId ?? "без профиля")}\n` +
      `${paint(output, "muted", "Контекст:")} ${context.strategy ?? "без стратегии"}${branch}\n`,
  );
  if (options.commandsHint)
    output.write(`${paint(output, "muted", "Команды: /help · /task · /memory · /profile · /invariants")}\n`);
}

export function printPrompt(output: Writable, text: string): void {
  output.write(`\n${paint(output, "user", `${text} >`)} `);
}

export function printSuccess(output: Writable, confirmation: string, details?: string): void {
  output.write(`${paint(output, "success", confirmation)}${details === undefined ? "" : ` ${details}`}\n`);
}

export function printNotice(output: Writable, text: string): void {
  output.write(`${text}\n`);
}

export function printWarning(output: Writable, text: string): void {
  output.write(`${paint(output, "action", text)}\n`);
}

export function printError(error: Writable, message: string): void {
  error.write(`${paint(error, "errorLabel", "Ошибка")}${paint(error, "error", ` · ${message}`)}\n`);
}

export function printAnswer(output: Writable, result: AgentResult): void {
  printBlock(output, "Ответ агента", [result.text]);

  const warnings: string[] = [];
  if (result.finishReason === "length") {
    warnings.push("Генерация остановилась по лимиту длины; ответ может быть неполным.");
  }
  if (!result.validation.ok) {
    warnings.push(`Формат не выдержан: ${result.validation.reason ?? "неизвестная причина"}.`);
  }
  if (warnings.length > 0) {
    printBlock(
      output,
      "Предупреждение",
      warnings.map((warning) => paint(output, "action", warning)),
    );
  }

  printBlock(
    output,
    "Токены",
    tokenLines(result).map((line) => paint(output, "muted", line)),
  );
}

function tokenLines({ tokenEstimate, usage }: AgentResult): string[] {
  const { factsCall, summaryCall, finalCall, turn, session } = usage;
  return [
    `Оценка ≈ вопрос ${formatCount(tokenEstimate.questionTokens)} · контекст ${formatCount(tokenEstimate.contextTokens)}`,
    `API, финал: вход ${formatCount(finalCall.promptTokens)} · генерация ${formatCount(finalCall.completionTokens)}`,
    `Из генерации: рассуждение ${formatCount(finalCall.reasoningTokens)}`,
    ...(summaryCall === null ? [] : [serviceCallLine("summary", summaryCall)]),
    ...(factsCall === null ? [] : [serviceCallLine("facts", factsCall)]),
    `Ход ${formatCount(turn.totalTokens)} · сессия ${formatCount(session.totalTokens)}`,
  ];
}

function serviceCallLine(name: string, call: TokenUsage): string {
  return (
    `API, ${name}: вход ${formatCount(call.promptTokens)} · генерация ${formatCount(call.completionTokens)}` +
    ` · итог ${formatCount(call.totalTokens)}`
  );
}

/** plan — черновик, ожидающий утверждения; question — открытый вопрос агента. Оба берутся из сохранённого состояния. */
export function printTaskState(
  output: Writable,
  view: TaskView,
  details: { plan?: boolean; question?: boolean } = {},
): void {
  const { context, status } = view;
  const lines = [
    paint(output, status.state === "done" ? "doneKey" : "key", `${STATE_TITLES[status.state]} (${status.state})`),
  ];
  if (status.paused) lines.push(paint(output, "action", "На паузе"));
  if (details.plan && status.state === "planning" && context.plan.length > 0 && context.waitingFor === null) {
    lines.push("План на утверждение:", ...planLines(context).map((line) => `  ${line}`));
  } else lines.push(progressLine(view));
  if (status.state === "execution" && context.review?.passed === false) {
    lines.push(paint(output, "muted", "Последняя проверка не пройдена: шаги выполняются заново."));
  }
  if (details.question && context.waitingFor !== null) {
    lines.push(`${paint(output, "key", "Вопрос агента:")} ${context.waitingFor}`);
  }
  lines.push(paint(output, "action", `Далее → ${nextAction(view)}`));
  printBlock(output, "Состояние задачи", lines);
}

function progressLine({ context, status }: TaskView): string {
  const steps = `Шаги: ${formatCount(context.results.length)}/${formatCount(context.plan.length)} выполнены.`;
  switch (status.state) {
    case "planning":
      return context.plan.length === 0 ? "Сбор требований." : "План предложен и ждёт утверждения.";
    case "execution":
      return status.step === null
        ? steps
        : `${steps} Сейчас шаг ${formatCount(status.step.number)} из ${formatCount(status.step.total)}: ${status.step.title}`;
    case "validation":
      return `${steps} ${context.review?.passed === false ? "Ожидается повторная проверка." : "Ожидается проверка."}`;
    case "done":
      return `${steps} Проверка пройдена.`;
  }
}

/** Подсказка к следующей реплике, в порядке ожидаемого действия статуса задачи. */
function nextAction({ context, status }: TaskView): string {
  if (status.paused) return "/task resume, чтобы вернуться к задаче; сейчас реплики идут в обычный чат";
  if (context.waitingFor !== null) return "ответьте на вопрос агента";
  switch (status.state) {
    case "planning":
      return context.plan.length === 0
        ? "уточните условия или попросите составить план"
        : "/task approve или попросите изменить план";
    case "execution":
      return status.step === null
        ? "продолжите текущий шаг, например репликой «Продолжай»"
        : `продолжите шаг ${formatCount(status.step.number)}, например репликой «Продолжай»`;
    case "validation":
      return "отправьте «Проверь результат»";
    case "done":
      return "обязательных действий нет; можно обсудить результат";
  }
}

function planLines(context: TaskContext): string[] {
  return context.plan.map((step, index) => {
    const marker =
      index < context.results.length
        ? "[x]"
        : context.state === "execution" && index === context.results.length
          ? "[>]"
          : "[ ]";
    return `${marker} ${formatCount(index + 1)}. ${step}`;
  });
}

/** Полный просмотр: план и вопрос выводятся своими блоками, поэтому в состоянии не повторяются. */
export function printTask(output: Writable, view: TaskView): void {
  const { context } = view;
  printBlock(output, "Описание задачи", [context.task]);
  printBlock(
    output,
    "План",
    context.plan.length === 0 ? [paint(output, "muted", "План ещё не предложен.")] : planLines(context),
  );
  printBlock(
    output,
    "Результаты шагов",
    context.results.length === 0
      ? [paint(output, "muted", "Результатов пока нет.")]
      : context.results.flatMap((result, index) => [
          ...(index === 0 ? [] : [""]),
          paint(output, "key", `Шаг ${formatCount(index + 1)}. ${context.plan[index]}`),
          result,
        ]),
  );
  printBlock(
    output,
    "Проверка",
    context.review === null
      ? [paint(output, "muted", "Сохранённой проверки нет.")]
      : context.review.passed
        ? [paint(output, "success", "Проверка пройдена:"), context.review.text]
        : [paint(output, "action", "Проверка не пройдена, замечания:"), context.review.text],
  );
  printBlock(
    output,
    "Вопрос агента",
    context.waitingFor === null ? [paint(output, "muted", "Открытого вопроса нет.")] : [context.waitingFor],
  );
  printTaskState(output, view);
}

export function printMemoryLayer<L extends MemoryLayer>(output: Writable, layer: L, value: MemorySnapshot[L]): void {
  const { title, subtitle } = MEMORY_TITLES[layer];
  const body =
    layer === "short" ? [JSON.stringify(value, null, 2)] : entryLines(output, value as MemoryEntries, "Записей нет.");
  printBlock(output, title, [paint(output, "muted", subtitle), ...body]);
}

export function printProfile(output: Writable, profileId: string, profile: AgentProfile | null): void {
  printBlock(output, `Профиль «${profileId}»`, entryLines(output, { ...profile }, "Профиль пуст."));
}

export function printProfileList(output: Writable, profileIds: readonly string[], activeId: string | null): void {
  if (profileIds.length === 0) {
    printNotice(output, "Сохранённых профилей нет. Создайте профиль командой /profile-init.");
    return;
  }
  printBlock(output, "Профили", [
    ...profileIds.map((id) => (id === activeId ? paint(output, "key", `* ${id} — активный`) : `- ${id}`)),
    ...(activeId === null ? [paint(output, "muted", "Профиль не выбран: /profile load profileId.")] : []),
  ]);
}

function entryLines(output: Writable, entries: Readonly<Record<string, string>>, empty: string): string[] {
  const keys = Object.keys(entries);
  if (keys.length === 0) return [paint(output, "muted", empty)];
  return keys.map((key) => `${paint(output, "key", `${key}:`)} ${entries[key]}`);
}

export function printInvariants(output: Writable, invariants: readonly InvariantInfo[]): void {
  printBlock(output, "Инварианты", [
    paint(
      output,
      "muted",
      "Обязательные правила ответа: общие для всех профилей, режимов и задач, командами не меняются.",
    ),
    ...(invariants.length === 0
      ? [paint(output, "muted", "Инвариантов нет.")]
      : invariants.map(({ id, description }) => `${paint(output, "key", `${id}:`)} ${description}`)),
  ]);
}

export function printBranches(
  output: Writable,
  branches: ReadonlyArray<{ name: string; active: boolean; messageCount: number }>,
): void {
  printBlock(
    output,
    "Ветки",
    branches.map(({ name, active, messageCount }) =>
      active
        ? paint(output, "key", `* ${name}: ${formatCount(messageCount)} сообщений — активная`)
        : `- ${name}: ${formatCount(messageCount)} сообщений`,
    ),
  );
}

export function printHelp(output: Writable, groups: readonly HelpGroup[]): void {
  printBlock(
    output,
    "Справка",
    groups.flatMap((group, index) => [
      ...(index === 0 ? [] : [""]),
      paint(output, "heading", group.title),
      ...group.lines.map((line) =>
        typeof line === "string"
          ? `  ${paint(output, "muted", line)}`
          : `  ${paint(output, "key", line[0])} — ${line[1]}`,
      ),
    ]),
  );
}

export function printProfileIntro(output: Writable, question: string): void {
  printBlock(output, "Настройка профиля", [
    paint(output, "muted", "/cancel — отменить, /exit — выйти без сохранения."),
    question,
  ]);
}

export function printProfileStep(output: Writable, step: ProfileStep): void {
  const emptyAnswer =
    step.current === undefined ? "Пустой ответ — пропустить группу." : "Пустой ответ — оставить прежнее значение.";
  printBlock(output, `Профиль «${step.profileId}» · ${step.position}/${step.total}`, [
    `${paint(output, "key", `${step.field}:`)} ${step.question}`,
    paint(output, "muted", `Подсказка: ${step.hint}.`),
    ...(step.current === undefined ? [] : [`${paint(output, "key", "Сейчас:")} ${step.current}`]),
    paint(output, "muted", emptyAnswer),
  ]);
}
