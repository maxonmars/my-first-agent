import { Readable, Writable } from "node:stream";
import { WriteStream } from "node:tty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentResult } from "../src/agent.ts";
import type { CliIo, SessionPort } from "../src/cli.ts";
import { runCli } from "../src/cli.ts";
import { formatCount } from "../src/cli-view.ts";
import { type TaskContext, TaskError, type TaskView, taskView } from "../src/task.ts";

const COLOR_VARIABLES = ["FORCE_COLOR", "NO_COLOR", "NODE_DISABLE_COLORS"] as const;

// Цвет зависит от окружения процесса: каждый тест начинает без этих переменных и возвращает исходные значения.
beforeEach(() => {
  for (const name of COLOR_VARIABLES) vi.stubEnv(name, undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

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

/** none — файл или pipe; color — терминал с цветом; tty — терминал, глубину цвета которого Node берёт из окружения. */
type Terminal = "none" | "color" | "tty";

function sink(onChunk: (chunk: string) => void, terminal: Terminal): Writable {
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      onChunk(chunk.toString());
      callback();
    },
  });
  if (terminal === "color") return Object.assign(stream, { isTTY: true, getColorDepth: () => 8 });
  if (terminal === "tty") {
    return Object.assign(stream, { isTTY: true, getColorDepth: WriteStream.prototype.getColorDepth });
  }
  return stream;
}

function capture(
  input = "",
  terminals: { output?: Terminal; error?: Terminal } = {},
): { io: CliIo; output: () => string; error: () => string } {
  let stdout = "";
  let stderr = "";

  return {
    io: {
      input: Readable.from([input]),
      output: sink((chunk) => {
        stdout += chunk;
      }, terminals.output ?? "none"),
      error: sink((chunk) => {
        stderr += chunk;
      }, terminals.error ?? "none"),
    },
    output: () => stdout,
    error: () => stderr,
  };
}

const ESC = "\u001b";
const ANSI = new RegExp(`${ESC}\\[(\\d+)m`, "g");

function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Каждый включённый в строке цвет и полужирный сброшены в той же строке. */
function expectClosedStyles(text: string): void {
  for (const line of text.split("\n")) {
    const codes = [...line.matchAll(ANSI)].map((match) => Number(match[1]));
    const count = (predicate: (code: number) => boolean) => codes.filter(predicate).length;
    expect(count((code) => (code >= 30 && code <= 37) || (code >= 90 && code <= 97))).toBe(
      count((code) => code === 39),
    );
    expect(count((code) => code === 1)).toBe(count((code) => code === 22));
  }
}

const HEADER = "── my-first-agent ──\n\nПользователь: без профиля\nКонтекст: sliding\n";
const COMMANDS_HINT = "Команды: /help · /task · /memory · /profile\n";
const RESET_MESSAGE = "Диалог выбранной стратегии и статистика очищены. Рабочая и долговременная память сохранены.";
const PAUSE_HINT = "Далее → /task resume, чтобы вернуться к задаче; сейчас реплики идут в обычный чат";

function tokensBlock(total = 7): string {
  return (
    "\n── Токены ──\n\n" +
    "Оценка ≈ вопрос 2 · контекст 30\n" +
    "API, финал: вход 4 · генерация 3\n" +
    "Из генерации: рассуждение 2\n" +
    `Ход ${total} · сессия ${total}\n`
  );
}

function fakeAgent(replies: Array<AgentResult | Error>): SessionPort & {
  respond: ReturnType<typeof vi.fn<SessionPort["respond"]>>;
  reset: ReturnType<typeof vi.fn<SessionPort["reset"]>>;
  getMemory: ReturnType<typeof vi.fn<SessionPort["getMemory"]>>;
  setMemory: ReturnType<typeof vi.fn<SessionPort["setMemory"]>>;
  deleteMemory: ReturnType<typeof vi.fn<SessionPort["deleteMemory"]>>;
  clearMemory: ReturnType<typeof vi.fn<SessionPort["clearMemory"]>>;
  getActiveUserId: ReturnType<typeof vi.fn<SessionPort["getActiveUserId"]>>;
  loadProfile: ReturnType<typeof vi.fn<SessionPort["loadProfile"]>>;
  initProfile: ReturnType<typeof vi.fn<SessionPort["initProfile"]>>;
  switchUser: ReturnType<typeof vi.fn<SessionPort["switchUser"]>>;
  setProfileField: ReturnType<typeof vi.fn<SessionPort["setProfileField"]>>;
  deleteProfileField: ReturnType<typeof vi.fn<SessionPort["deleteProfileField"]>>;
  clearProfile: ReturnType<typeof vi.fn<SessionPort["clearProfile"]>>;
  createCheckpoint: ReturnType<typeof vi.fn<SessionPort["createCheckpoint"]>>;
  createBranch: ReturnType<typeof vi.fn<SessionPort["createBranch"]>>;
  switchBranch: ReturnType<typeof vi.fn<SessionPort["switchBranch"]>>;
  listBranches: ReturnType<typeof vi.fn<SessionPort["listBranches"]>>;
  getTask: ReturnType<typeof vi.fn<SessionPort["getTask"]>>;
  startTask: ReturnType<typeof vi.fn<SessionPort["startTask"]>>;
  approveTask: ReturnType<typeof vi.fn<SessionPort["approveTask"]>>;
  pauseTask: ReturnType<typeof vi.fn<SessionPort["pauseTask"]>>;
  resumeTask: ReturnType<typeof vi.fn<SessionPort["resumeTask"]>>;
  clearTask: ReturnType<typeof vi.fn<SessionPort["clearTask"]>>;
} {
  let index = 0;
  const respond = vi.fn<SessionPort["respond"]>(async () => {
    const reply = replies[index];
    index += 1;

    if (reply === undefined) throw new Error("Нет ответа fake-агента.");
    if (reply instanceof Error) throw reply;

    return reply;
  });
  const reset = vi.fn<SessionPort["reset"]>();

  return {
    respond,
    reset,
    getContextStatus: () => ({ strategy: "sliding", activeBranch: null }),
    getMemory: vi.fn<SessionPort["getMemory"]>(() => ({
      short: { kind: "sliding", messages: [] },
      working: {},
      long: {},
    })),
    setMemory: vi.fn<SessionPort["setMemory"]>(),
    deleteMemory: vi.fn<SessionPort["deleteMemory"]>(() => true),
    clearMemory: vi.fn<SessionPort["clearMemory"]>(),
    getActiveUserId: vi.fn<SessionPort["getActiveUserId"]>(() => null),
    loadProfile: vi.fn<SessionPort["loadProfile"]>(() => null),
    initProfile: vi.fn<SessionPort["initProfile"]>(),
    switchUser: vi.fn<SessionPort["switchUser"]>(),
    setProfileField: vi.fn<SessionPort["setProfileField"]>(),
    deleteProfileField: vi.fn<SessionPort["deleteProfileField"]>(() => true),
    clearProfile: vi.fn<SessionPort["clearProfile"]>(),
    createCheckpoint: vi.fn<SessionPort["createCheckpoint"]>(),
    createBranch: vi.fn<SessionPort["createBranch"]>(),
    switchBranch: vi.fn<SessionPort["switchBranch"]>(),
    listBranches: vi.fn<SessionPort["listBranches"]>(() => [{ name: "main", active: true, messageCount: 0 }]),
    getTask: vi.fn<SessionPort["getTask"]>(() => null),
    startTask: vi.fn<SessionPort["startTask"]>(),
    approveTask: vi.fn<SessionPort["approveTask"]>(),
    pauseTask: vi.fn<SessionPort["pauseTask"]>(() => true),
    resumeTask: vi.fn<SessionPort["resumeTask"]>(() => true),
    clearTask: vi.fn<SessionPort["clearTask"]>(() => true),
  };
}

/** Методы, которые вызывают модель или меняют историю, память, профили, ветки и задачу. */
function mutatingMethods(agent: ReturnType<typeof fakeAgent>) {
  return [
    agent.respond,
    agent.reset,
    agent.setMemory,
    agent.deleteMemory,
    agent.clearMemory,
    agent.initProfile,
    agent.switchUser,
    agent.setProfileField,
    agent.deleteProfileField,
    agent.clearProfile,
    agent.createCheckpoint,
    agent.createBranch,
    agent.switchBranch,
    agent.startTask,
    agent.approveTask,
    agent.pauseTask,
    agent.resumeTask,
    agent.clearTask,
  ];
}

const PLAN = ["Определить допустимое содержание ответа", "Подготовить текст клиенту"];

function view(overrides: Partial<TaskContext> = {}): TaskView {
  return taskView({
    task: "Ответить клиенту о задержке",
    state: "planning",
    paused: false,
    plan: [],
    results: [],
    waitingFor: null,
    review: null,
    ...overrides,
  });
}

/** Fake-агент с задачей, которую команды меняют как настоящий агент. */
function taskAgent(initial: TaskView | null, replies: AgentResult[] = []) {
  const agent = fakeAgent(replies);
  let current = initial;
  const update = (overrides: Partial<TaskContext>) => {
    current = view({ ...current!.context, ...overrides });
  };
  agent.getTask.mockImplementation(() => current);
  agent.startTask.mockImplementation((description) => {
    current = view({ task: description.trim() });
  });
  agent.approveTask.mockImplementation(() => update({ state: "execution" }));
  agent.pauseTask.mockImplementation(() => {
    if (current!.context.paused) return false;
    update({ paused: true });
    return true;
  });
  agent.resumeTask.mockImplementation(() => {
    if (!current!.context.paused) return false;
    update({ paused: false });
    return true;
  });
  agent.clearTask.mockImplementation(() => {
    const existed = current !== null;
    current = null;
    return existed;
  });
  return Object.assign(agent, {
    setTask: (next: TaskView | null) => {
      current = next;
    },
  });
}

function stateBlock(lines: string[]): string {
  return `\n── Состояние задачи ──\n\n${lines.join("\n")}\n`;
}

describe("one-shot CLI", () => {
  it("passes the joined argument to the agent and prints the header, answer and token blocks", async () => {
    const agent = fakeAgent([result("готовый ответ", { total: 9 })]);
    const streams = capture();

    const code = await runCli(agent, ["сложный", "вопрос"], streams.io);

    expect(code).toBe(0);
    expect(agent.respond).toHaveBeenCalledWith("сложный вопрос");
    expect(streams.output()).toBe(`${HEADER}\n── Ответ агента ──\n\nготовый ответ\n${tokensBlock(9)}`);
    expect(streams.error()).toBe("");
  });

  it("returns failure and prints an agent error without a stack trace", async () => {
    const agent = fakeAgent([new Error("API недоступен")]);
    const streams = capture();

    const code = await runCli(agent, ["вопрос"], streams.io);

    expect(code).toBe(1);
    expect(streams.error()).toBe("Ошибка · Запрос не удался: API недоступен\n");
    expect(streams.error()).not.toContain(" at ");
    expect(streams.output()).toBe(HEADER);
  });

  it("prints a validation problem returned by the agent", async () => {
    const agent = fakeAgent([result("невалидный ответ", { valid: false })]);
    const streams = capture();

    await runCli(agent, ["вопрос"], streams.io);

    expect(streams.output()).toContain("\n── Предупреждение ──\n\nФормат не выдержан: нарушен контракт.\n");
  });
});

describe("interactive CLI", () => {
  it("starts with a compact header and a commands hint instead of the full help", async () => {
    const agent = fakeAgent([]);
    const streams = capture("/exit\n");

    expect(await runCli(agent, [], streams.io)).toBe(0);

    expect(streams.output()).toBe(`${HEADER}${COMMANDS_HINT}\nбез профиля > `);
  });

  it("ignores blank lines, handles reset and stops on exit", async () => {
    const agent = fakeAgent([result("первый ответ"), result("второй ответ")]);
    const streams = capture("\nпервый вопрос\n/reset\nвторой вопрос\n/exit\nлишний вопрос\n");

    const code = await runCli(agent, [], streams.io);

    expect(code).toBe(0);
    expect(agent.respond.mock.calls).toEqual([["первый вопрос"], ["второй вопрос"]]);
    expect(agent.reset).toHaveBeenCalledOnce();
    expect(streams.output()).toContain(`без профиля > ${RESET_MESSAGE}\n\nбез профиля > `);
  });

  it("continues the dialog after an agent error", async () => {
    const agent = fakeAgent([new Error("временный сбой"), result("ответ после сбоя")]);
    const streams = capture("первый\nвторой\n/exit\n");

    await runCli(agent, [], streams.io);

    expect(agent.respond).toHaveBeenCalledTimes(2);
    expect(streams.error()).toBe("Ошибка · Запрос не удался: временный сбой\n");
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
    expect(streams.error()).toBe("Ошибка · Не удалось сбросить контекст: Не удалось сохранить историю: EACCES.\n");
    expect(streams.output()).not.toContain("очищены");
    expect(agent.respond).toHaveBeenCalledWith("следующий вопрос");
    expect(streams.output()).toContain("ответ после ошибки сброса");
  });

  it("prints non-Error failures safely", async () => {
    const agent = fakeAgent([]);
    agent.respond.mockRejectedValueOnce("неизвестный сбой");
    const streams = capture("вопрос\n/exit\n");

    await runCli(agent, [], streams.io);

    expect(streams.error()).toBe("Ошибка · Запрос не удался: неизвестный сбой\n");
  });
});

describe("help", () => {
  const GROUPS: Array<[string, string[]]> = [
    ["Диалог", ["/help", "/reset", "/exit"]],
    ["Задача", ["/task", "/task start описание", "/task approve", "/task pause", "/task resume", "/task clear"]],
    [
      "Память",
      [
        "/memory",
        "/memory show short|working|long",
        "/memory set working|long ключ значение",
        "/memory delete working|long ключ",
        "/memory clear short|working|long",
      ],
    ],
    [
      "Профиль",
      [
        "/profile-init",
        "/profile",
        "/profile load userId",
        "/profile set style|constraints|context значение",
        "/profile delete style|constraints|context",
        "/profile clear",
      ],
    ],
    ["Ветки", ["/checkpoint", "/branch имя", "/switch имя", "/branches"]],
  ];

  it("prints every command in its group for /help and /HELP without touching the agent state", async () => {
    const agent = taskAgent(view({ plan: PLAN }));
    const streams = capture("/help\n/HELP\n/exit\n");

    await runCli(agent, [], streams.io);

    const blocks = streams.output().split("\n── Справка ──\n\n").slice(1);
    expect(blocks).toHaveLength(2);
    const help = blocks[0]!.split("\n\nбез профиля [задача] > ")[0]!;
    expect(blocks[1]!.startsWith(help)).toBe(true);
    const starts = GROUPS.map(([title]) => help.indexOf(`${title}\n  `));
    expect(starts[0]).toBe(0);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    GROUPS.forEach(([, commands], index) => {
      const group = help.slice(starts[index], starts[index + 1]);
      for (const command of commands) expect(group).toContain(`\n  ${command} — `);
    });
    expect(help).toContain(
      "/reset — очистить историю выбранной стратегии и статистику; рабочая и долговременная память, профиль и задача сохраняются",
    );
    expect(help).toContain("Новый разговор: /reset, затем /memory clear working — рабочая память очищается отдельно.");
    expect(help).toContain("Задачу удаляет только /task clear.");
    expect(help.slice(starts[4])).toContain("Только в режиме branching");
    for (const method of [...mutatingMethods(agent), agent.getMemory, agent.loadProfile, agent.listBranches]) {
      expect(method).not.toHaveBeenCalled();
    }
    expect(streams.error()).toBe("");
  });

  it("rejects /help with arguments and in one-shot mode", async () => {
    const agent = fakeAgent([]);
    const streams = capture("/help memory\n/exit\n");

    await runCli(agent, [], streams.io);

    expect(streams.error()).toBe("Ошибка · Команда не выполнена: Лишние аргументы. Использование: /help\n");
    expect(streams.output()).not.toContain("Справка");

    const oneShot = capture();
    expect(await runCli(agent, ["/help"], oneShot.io)).toBe(1);
    expect(oneShot.output()).toBe(HEADER);
    expect(oneShot.error()).toBe(
      "Ошибка · Команды доступны только в интерактивном режиме: запустите CLI без аргументов.\n",
    );
    for (const method of mutatingMethods(agent)) expect(method).not.toHaveBeenCalled();
  });
});

describe("turn output", () => {
  function fullResult(text: string): AgentResult {
    return {
      text,
      finishReason: "length",
      validation: { ok: false, reason: "нет заголовка Markdown" },
      tokenEstimate: { questionTokens: 3, contextTokens: 1292 },
      usage: {
        summaryCall: { promptTokens: 1200, completionTokens: 80, reasoningTokens: 0, totalTokens: 1280 },
        factsCall: { promptTokens: 900, completionTokens: 40, reasoningTokens: 0, totalTokens: 940 },
        finalCall: { promptTokens: 1594, completionTokens: 349, reasoningTokens: 71, totalTokens: 1943 },
        turn: { promptTokens: 3694, completionTokens: 469, reasoningTokens: 71, totalTokens: 4163 },
        session: { promptTokens: 9000, completionTokens: 1250, reasoningTokens: 100, totalTokens: 10250 },
      },
    };
  }

  it("keeps the answer as is and orders answer, warnings, tokens, task state and prompt", async () => {
    const answer = "Задача выполнена.\n\n## Итог\n\n- пункт  с двумя пробелами\n```ts\nconst x = 1;\n```\n  отступ";
    const agent = taskAgent(view({ state: "validation", plan: PLAN, results: ["первый", "второй"] }), [
      fullResult(answer),
    ]);
    const streams = capture("Проверь результат\n/exit\n");

    await runCli(agent, [], streams.io);

    const turn = streams.output().split("без профиля [задача] > ")[1]!;
    expect(turn).toBe(
      `\n── Ответ агента ──\n\n${answer}\n` +
        "\n── Предупреждение ──\n\n" +
        "Генерация остановилась по лимиту длины; ответ может быть неполным.\n" +
        "Формат не выдержан: нет заголовка Markdown.\n" +
        "\n── Токены ──\n\n" +
        "Оценка ≈ вопрос 3 · контекст 1 292\n" +
        "API, финал: вход 1 594 · генерация 349\n" +
        "Из генерации: рассуждение 71\n" +
        "API, summary: вход 1 200 · генерация 80 · итог 1 280\n" +
        "API, facts: вход 900 · генерация 40 · итог 940\n" +
        "Ход 4 163 · сессия 10 250\n" +
        stateBlock([
          "Проверка результатов (validation)",
          "Шаги: 2/2 выполнены. Ожидается проверка.",
          "Далее → отправьте «Проверь результат»",
        ]) +
        "\n",
    );
    expect(streams.output()).not.toContain("Завершена");
    expect(streams.output()).not.toContain("Следующая реплика");
  });

  it("does not repeat the user's line and ends an answer that already has a newline once", async () => {
    const agent = fakeAgent([result("ответ\n")]);
    const streams = capture("вопрос пользователя\n/exit\n");

    await runCli(agent, [], streams.io);

    expect(streams.output()).not.toContain("вопрос пользователя");
    expect(streams.output()).toContain(`\n── Ответ агента ──\n\nответ\n${tokensBlock()}`);
  });

  it.each([
    [0, "0"],
    [999, "999"],
    [1000, "1 000"],
    [1594, "1 594"],
    [1234567, "1 234 567"],
  ])("formats %i as %s", (value, formatted) => {
    expect(formatCount(value)).toBe(formatted);
  });
});

it("dispatches branch commands locally, lists the active branch and keeps dialog input separate", async () => {
  const agent = fakeAgent([result("answer")]);
  agent.getContextStatus = () => ({ strategy: "branching", activeBranch: "main" });
  agent.listBranches.mockReturnValue([
    { name: "main", active: false, messageCount: 2 },
    { name: "a", active: true, messageCount: 1000 },
  ]);
  const streams = capture("/checkpoint\n/branch a\n/switch main\n/branches\nquestion\n/exit\n");
  await runCli(agent, [], streams.io);
  expect(agent.createCheckpoint).toHaveBeenCalledOnce();
  expect(agent.createBranch).toHaveBeenCalledWith("a");
  expect(agent.switchBranch).toHaveBeenCalledWith("main");
  expect(agent.respond).toHaveBeenCalledExactlyOnceWith("question");
  const output = streams.output();
  expect(output).toContain("Контекст: branching, ветка: main");
  expect(output).toContain("> Checkpoint сохранён из активной ветки.\n");
  expect(output).toContain("> Активная ветка: a\n");
  expect(output).toContain("\n── Ветки ──\n\n- main: 2 сообщений\n* a: 1 000 сообщений — активная\n");
  expect(streams.error()).toBe("");
});

it.each(["/checkpoint extra", "/branch", "/branch a b", "/switch", "/switch a b", "/branches extra", "/unknown"])(
  "reports malformed command %s without calling the LLM",
  async (command) => {
    const agent = fakeAgent([]);
    const streams = capture(`${command}\n/exit\n`);
    await runCli(agent, [], streams.io);
    expect(streams.error()).toMatch(/^Ошибка · Команда не выполнена: /);
    expect(agent.respond).not.toHaveBeenCalled();
  },
);

it("reports branch save failure without claiming success and continues", async () => {
  const agent = fakeAgent([result("answer")]);
  agent.createCheckpoint.mockImplementationOnce(() => {
    throw new Error("disk");
  });
  const streams = capture("/checkpoint\nquestion\n/exit\n");
  await runCli(agent, [], streams.io);
  expect(streams.error()).toBe("Ошибка · Команда не выполнена: disk\n");
  expect(streams.output()).not.toContain("Checkpoint сохранён");
  expect(agent.respond).toHaveBeenCalledExactlyOnceWith("question");
});

describe("memory commands", () => {
  function expectNoAgentCalls(agent: ReturnType<typeof fakeAgent>): void {
    for (const method of [agent.respond, agent.reset, agent.setMemory, agent.deleteMemory, agent.clearMemory]) {
      expect(method).not.toHaveBeenCalled();
    }
  }

  it("passes the whole multi-word value, keeps key and value case and reports success after the write", async () => {
    const agent = fakeAgent([]);
    const streams = capture(
      "/memory set working goal  поездка в  Казань \n/MEMORY SET Long Transport Предпочитаю Поезд\n/exit\n",
    );

    await runCli(agent, [], streams.io);

    expect(agent.setMemory.mock.calls).toEqual([
      ["working", "goal", "поездка в  Казань"],
      ["long", "Transport", "Предпочитаю Поезд"],
    ]);
    expect(streams.output()).toContain("Запись «goal» сохранена в working.");
    expect(streams.output()).toContain("Запись «Transport» сохранена в long.");
    expect(agent.respond).not.toHaveBeenCalled();
    expect(streams.error()).toBe("");
  });

  it("shows all layers or one layer, deletes and clears through the agent port", async () => {
    const agent = fakeAgent([]);
    agent.getMemory.mockReturnValue({
      short: {
        kind: "sliding",
        messages: [
          { role: "user", content: "Код — КЕДР" },
          { role: "assistant", content: "Принято" },
        ],
      },
      working: { goal: "поездка в Казань", note: "первая строка\nвторая строка" },
      long: {},
    });
    agent.deleteMemory.mockReturnValueOnce(true).mockReturnValueOnce(false);
    const streams = capture(
      "/memory\n/memory show WORKING\n/memory delete long transport\n/memory delete long transport\n" +
        "/memory clear working\n/memory clear short\n/exit\n",
    );

    await runCli(agent, [], streams.io);

    const [all, rest] = streams.output().split("Запись «transport» удалена из long.");
    const shortAt = all!.indexOf("\n── Краткосрочная память (short) ──\n");
    const workingAt = all!.indexOf("\n── Рабочая память (working) ──\n");
    const longAt = all!.indexOf("\n── Долговременная память (long) ──\n");
    expect(shortAt).toBeGreaterThan(-1);
    expect(shortAt).toBeLessThan(workingAt);
    expect(workingAt).toBeLessThan(longAt);
    expect(all!.slice(shortAt, workingAt)).toContain(
      'Состояние диалога выбранной стратегии.\n{\n  "kind": "sliding",\n  "messages": [',
    );
    expect(all!.slice(shortAt, workingAt)).toContain('"content": "Код — КЕДР"');
    const working = "Условия текущей задачи.\ngoal: поездка в Казань\nnote: первая строка\nвторая строка\n";
    expect(all!.slice(workingAt, longAt)).toContain(working);
    expect(all!.slice(longAt)).toContain("Сведения, предпочтения и знания.\nЗаписей нет.\n");
    const shown = all!.slice(longAt).split("── Рабочая память (working) ──")[1]!;
    expect(shown).toContain(working);
    expect(shown).not.toContain("Долговременная память");
    expect(rest).toContain("Запись «transport» не найдена в long.");
    expect(rest).toContain("Слой working очищен.");
    expect(rest).toContain(RESET_MESSAGE);
    expect(agent.deleteMemory.mock.calls).toEqual([
      ["long", "transport"],
      ["long", "transport"],
    ]);
    expect(agent.clearMemory.mock.calls).toEqual([["working"], ["short"]]);
    expect(agent.respond).not.toHaveBeenCalled();
    expect(agent.reset).not.toHaveBeenCalled();
    expect(streams.error()).toBe("");
  });

  it.each([
    ["/memory list", "Неизвестное действие памяти «list»"],
    ["/memory show", "Не указан слой памяти"],
    ["/memory show all", "Неизвестный слой памяти «all»"],
    ["/memory show working extra", "Лишние аргументы"],
    ["/memory set working", "Не хватает аргументов"],
    ["/memory set working goal", "Не хватает аргументов"],
    ["/memory set short goal значение", "Слой short изменяется только диалогом"],
    ["/memory delete long", "Не хватает аргументов"],
    ["/memory delete long a b", "Лишние аргументы"],
    ["/memory delete short goal", "Слой short изменяется только диалогом"],
    ["/memory clear", "Не указан слой памяти"],
    ["/memory clear all", "Неизвестный слой памяти «all»"],
    ["/memory clear working now", "Лишние аргументы"],
  ])("reports %s with the reason and syntax without calling the agent", async (command, reason) => {
    const agent = fakeAgent([]);
    const streams = capture(`${command}\n/exit\n`);

    await runCli(agent, [], streams.io);

    expect(streams.error()).toContain(`Ошибка · Команда не выполнена: ${reason}`);
    expect(streams.error()).toContain("Использование: /memory");
    expect(agent.getMemory).not.toHaveBeenCalled();
    expectNoAgentCalls(agent);
  });

  it("reports memory write failures without a false success and continues", async () => {
    const agent = fakeAgent([result("ответ")]);
    agent.setMemory.mockImplementationOnce(() => {
      throw new Error("Не удалось сохранить память working: ENOSPC.");
    });
    agent.clearMemory.mockImplementationOnce(() => {
      throw new Error("disk");
    });
    const streams = capture("/memory set working goal поездка\n/memory clear short\nвопрос\n/exit\n");

    await runCli(agent, [], streams.io);

    expect(streams.error()).toBe(
      "Ошибка · Команда не выполнена: Не удалось сохранить память working: ENOSPC.\n" +
        "Ошибка · Команда не выполнена: disk\n",
    );
    expect(streams.output()).not.toContain("сохранена в working");
    expect(streams.output()).not.toContain(RESET_MESSAGE);
    expect(agent.respond).toHaveBeenCalledExactlyOnceWith("вопрос");
  });

  it.each([["/memory", "show"], ["/reset"], [" /memory set working goal поездка"]])(
    "rejects one-shot command %j without calling the model",
    async (...args) => {
      const agent = fakeAgent([]);
      const streams = capture();

      expect(await runCli(agent, args, streams.io)).toBe(1);

      expect(streams.error()).toBe(
        "Ошибка · Команды доступны только в интерактивном режиме: запустите CLI без аргументов.\n",
      );
      expect(agent.getMemory).not.toHaveBeenCalled();
      expectNoAgentCalls(agent);
    },
  );
});

describe("profile wizard", () => {
  function withActiveUser(agent: ReturnType<typeof fakeAgent>, initial: string | null = null) {
    let active = initial;
    agent.getActiveUserId.mockImplementation(() => active);
    agent.initProfile.mockImplementation((userId) => {
      active = userId;
    });
    agent.switchUser.mockImplementation((userId) => {
      active = userId;
    });
    return agent;
  }

  function expectNoOtherCalls(agent: ReturnType<typeof fakeAgent>): void {
    for (const method of [
      agent.respond,
      agent.reset,
      agent.getMemory,
      agent.setMemory,
      agent.switchUser,
      agent.setProfileField,
      agent.deleteProfileField,
      agent.clearProfile,
    ]) {
      expect(method).not.toHaveBeenCalled();
    }
  }

  it("asks the identifier and three groups, then saves and activates the user without the model", async () => {
    const agent = withActiveUser(fakeAgent([]));
    agent.loadProfile.mockReturnValueOnce(null);
    agent.loadProfile.mockReturnValueOnce({ style: "На ты, списком", context: "Backend-разработчик" });
    const streams = capture("/profile-init\n  Макс  \n На ты, списком \nБез эмодзи\nBackend-разработчик\n/exit\n");

    expect(await runCli(agent, [], streams.io)).toBe(0);

    // Второе чтение — показ итогового профиля после сохранения.
    expect(agent.loadProfile.mock.calls).toEqual([["Макс"], ["Макс"]]);
    expect(agent.loadProfile.mock.invocationCallOrder[1]).toBeGreaterThan(
      agent.initProfile.mock.invocationCallOrder[0]!,
    );
    expect(agent.initProfile).toHaveBeenCalledExactlyOnceWith("Макс", {
      style: "На ты, списком",
      constraints: "Без эмодзи",
      context: "Backend-разработчик",
    });
    const output = streams.output();
    expect(output.startsWith(`${HEADER}${COMMANDS_HINT}`)).toBe(true);
    expect(output).toContain(
      "без профиля > \n── Настройка профиля ──\n\n/cancel — отменить, /exit — выйти без сохранения.\n" +
        "Укажите идентификатор пользователя, например Макс или Владимир.\n\nпрофиль > Новый профиль «Макс».\n",
    );
    expect(output).toContain(
      "\n── Профиль «Макс» · 1/3 ──\n\nstyle: Как с вами общаться и оформлять ответы?\nПодсказка: обращение, «ты» или «вы», тон",
    );
    expect(output).toContain(
      "\n── Профиль «Макс» · 2/3 ──\n\nconstraints: Какие правила соблюдать и чего избегать в ответах?",
    );
    expect(output).toContain("Подсказка: эмодзи, код без просьбы");
    expect(output).toContain(
      "\n── Профиль «Макс» · 3/3 ──\n\ncontext: Что стоит знать о вас, чтобы ответы были полезнее?",
    );
    expect(output).toContain("Подсказка: занятие, уровень опыта");
    expect(output.match(/\nпрофиль Макс > /g)).toHaveLength(3);
    expect(output).toContain(
      "профиль Макс > Профиль «Макс» сохранён.\nПользователь: Макс\nКонтекст: sliding\n" +
        "\n── Профиль «Макс» ──\n\nstyle: На ты, списком\ncontext: Backend-разработчик\n\nМакс > ",
    );
    expect(output.endsWith("\nМакс > ")).toBe(true);
    expect(streams.error()).toBe("");
    expectNoOtherCalls(agent);
  });

  it("skips empty answers for a new profile and keeps previous values when editing an existing one", async () => {
    const agent = withActiveUser(fakeAgent([]), "Макс");
    agent.loadProfile.mockImplementation((userId) =>
      userId === "Владимир" ? { style: "На вы", context: "Начинающий" } : null,
    );
    const streams = capture(
      "/profile-init\nНовый\n\n\nКонтекст\n/profile-init\nВладимир\n\nПояснять термины\n\n/exit\n",
    );

    await runCli(agent, [], streams.io);

    expect(agent.initProfile.mock.calls).toEqual([
      ["Новый", { context: "Контекст" }],
      ["Владимир", { style: "На вы", context: "Начинающий", constraints: "Пояснять термины" }],
    ]);
    const [created, edited] = streams.output().split("Изменение профиля «Владимир».");
    expect(created!.match(/Пустой ответ — пропустить группу\./g)).toHaveLength(3);
    expect(created).toContain("── Профиль «Новый» ──\n\nПрофиль пуст.\n");
    expect(edited).toContain("Сейчас: На вы\nПустой ответ — оставить прежнее значение.");
    expect(edited).toContain("Сейчас: Начинающий\nПустой ответ — оставить прежнее значение.");
    expect(edited).toContain("Пустой ответ — пропустить группу.");
    expect(streams.output().endsWith("Владимир > ")).toBe(true);
  });

  it("repeats the identifier question after an invalid answer without loading or saving", async () => {
    const agent = withActiveUser(fakeAgent([]));
    const streams = capture("/profile-init\nМакс Иванов\n\n_maks\nМакс\n\n\n\n/exit\n");

    await runCli(agent, [], streams.io);

    expect(streams.error().match(/Ошибка · Неверный идентификатор пользователя: 1–64 символа/g)).toHaveLength(3);
    expect(streams.error().match(/\nУкажите идентификатор пользователя/g)).toHaveLength(3);
    expect(agent.loadProfile.mock.calls[0]).toEqual(["Макс"]);
    expect(agent.loadProfile.mock.calls.flat()).not.toContain("Макс Иванов");
    expect(agent.initProfile).toHaveBeenCalledExactlyOnceWith("Макс", {});
  });

  it.each([
    ["/cancel", "стиль\n/CANCEL\nвопрос\n/exit\n", ["вопрос"]],
    ["/exit", "стиль\n/Exit\nвопрос\n", []],
    ["end of input", "стиль\nправила\n", []],
    ["/cancel at the identifier", "", []],
  ])("discards the draft on %s", async (name, rest, questions) => {
    const agent = withActiveUser(fakeAgent([result("ответ")]), "Владимир");
    const input =
      name === "/cancel at the identifier" ? "/profile-init\n/cancel\n/exit\n" : `/profile-init\nМакс\n${rest}`;
    const streams = capture(input);

    expect(await runCli(agent, [], streams.io)).toBe(0);

    expect(agent.initProfile).not.toHaveBeenCalled();
    expect(agent.respond.mock.calls).toEqual(questions.map((question) => [question]));
    expect(streams.output()).not.toContain("сохранён");
    if (name.startsWith("/cancel")) {
      expect(streams.output()).toContain("Настройка профиля отменена, изменения не сохранены.\n\nВладимир > ");
    }
  });

  it("does not run other slash commands, including /help, during the wizard or store them as values", async () => {
    const agent = withActiveUser(fakeAgent([]));
    const streams = capture(
      "/profile-init\n/memory\nМакс\n/reset\n/help\n/profile load Владимир\n/profile-init\nстиль\n/checkpoint\n\n\n/exit\n",
    );

    await runCli(agent, [], streams.io);

    expect(streams.output().match(/Во время настройки профиля команды не выполняются/g)).toHaveLength(6);
    expect(streams.output()).not.toContain("Справка");
    expect(agent.initProfile).toHaveBeenCalledExactlyOnceWith("Макс", { style: "стиль" });
    expect(agent.createCheckpoint).not.toHaveBeenCalled();
    expectNoOtherCalls(agent);
  });

  it("reports a failed save, ends the wizard and keeps the previous user", async () => {
    const agent = withActiveUser(fakeAgent([result("ответ")]), "Владимир");
    agent.initProfile.mockImplementationOnce(() => {
      throw new Error("Не удалось загрузить историю: некорректный JSON.");
    });
    const streams = capture("/profile-init\nМакс\nстиль\n\n\nвопрос\n/exit\n");

    await runCli(agent, [], streams.io);

    expect(streams.error()).toBe("Ошибка · Профиль не сохранён: Не удалось загрузить историю: некорректный JSON.\n");
    expect(streams.output()).not.toContain("сохранён");
    expect(streams.output()).not.toContain("Пользователь: Макс");
    expect(streams.output().replaceAll("профиль Макс > ", "")).not.toContain("Макс > ");
    expect(agent.respond).toHaveBeenCalledExactlyOnceWith("вопрос");
    expect(streams.output().endsWith("Владимир > ")).toBe(true);
  });

  it("rejects arguments of /profile-init and the command in one-shot mode", async () => {
    const agent = withActiveUser(fakeAgent([]), "Макс");
    const streams = capture("/PROFILE-INIT Макс\n/exit\n");
    await runCli(agent, [], streams.io);
    expect(streams.error()).toBe("Ошибка · Команда не выполнена: Лишние аргументы. Использование: /profile-init\n");
    expect(agent.loadProfile).not.toHaveBeenCalled();

    const oneShot = capture();
    expect(await runCli(agent, ["/profile-init"], oneShot.io)).toBe(1);
    expect(oneShot.output()).toBe("── my-first-agent ──\n\nПользователь: Макс\nКонтекст: sliding\n");
    expect(agent.initProfile).not.toHaveBeenCalled();
    expectNoOtherCalls(agent);
  });
});

describe("profile commands", () => {
  function activeAgent(active: string | null) {
    const agent = fakeAgent([result("ответ")]);
    let current = active;
    agent.getActiveUserId.mockImplementation(() => current);
    agent.switchUser.mockImplementation((userId) => {
      current = userId;
    });
    return agent;
  }

  it("shows the active user in the one-shot header and in the interactive prompt", async () => {
    const oneShot = capture();
    await runCli(activeAgent("Макс"), ["вопрос"], oneShot.io);
    expect(oneShot.output()).toBe(
      `── my-first-agent ──\n\nПользователь: Макс\nКонтекст: sliding\n\n── Ответ агента ──\n\nответ\n${tokensBlock()}`,
    );

    const interactive = capture("Объясни кеширование.\n/exit\n");
    await runCli(activeAgent("Макс"), [], interactive.io);
    expect(interactive.output()).toContain(`${COMMANDS_HINT}\nМакс > \n── Ответ агента ──\n\nответ\n`);
    expect(interactive.output().endsWith(`${tokensBlock()}\nМакс > `)).toBe(true);
  });

  it("shows the profile as key-value pairs or suggests /profile-init without a selected user", async () => {
    const agent = activeAgent("Макс");
    agent.loadProfile.mockReturnValue({ style: "На ты\nсписком", context: "Backend" });
    const streams = capture("/PROFILE\n/exit\n");
    await runCli(agent, [], streams.io);
    expect(streams.output()).toContain("\n── Профиль «Макс» ──\n\nstyle: На ты\nсписком\ncontext: Backend\n\nМакс > ");
    expect(agent.loadProfile).toHaveBeenCalledWith("Макс");

    const none = capture("/profile\n/exit\n");
    await runCli(activeAgent(null), [], none.io);
    expect(none.output()).toContain(
      "Пользователь не выбран: работа без профиля. Создайте профиль командой /profile-init.\n\nбез профиля > ",
    );
  });

  it("switches users, updates the status and prompt only after success", async () => {
    const agent = activeAgent("Макс");
    agent.switchUser.mockImplementationOnce(() => {
      throw new Error("Профиль «Никто» не найден. Создайте его командой /profile-init.");
    });
    const streams = capture("/profile load Никто\n/Profile LOAD Владимир\n/profile load Владимир\n/exit\n");

    await runCli(agent, [], streams.io);

    expect(agent.switchUser.mock.calls).toEqual([["Никто"], ["Владимир"], ["Владимир"]]);
    expect(streams.error()).toBe(
      "Ошибка · Команда не выполнена: Профиль «Никто» не найден. Создайте его командой /profile-init.\n",
    );
    const output = streams.output();
    expect(output).toContain("Макс > \nМакс > Пользователь: Владимир\nКонтекст: sliding\n\nВладимир > ");
    expect(output).toContain("Владимир > Пользователь «Владимир» уже выбран.\nПользователь: Владимир\n");
    expect(output).not.toContain("Пользователь: Никто");
    expect(agent.respond).not.toHaveBeenCalled();
  });

  it("sets, deletes and clears groups with case-insensitive names and the whole value", async () => {
    const agent = activeAgent("Макс");
    agent.deleteProfileField.mockReturnValueOnce(true).mockReturnValueOnce(false);
    const streams = capture(
      "/profile set STYLE  На вы,  подробно \n/profile Delete constraints\n/profile delete constraints\n/profile clear\n/exit\n",
    );

    await runCli(agent, [], streams.io);

    expect(agent.setProfileField).toHaveBeenCalledExactlyOnceWith("style", "На вы,  подробно");
    expect(agent.deleteProfileField.mock.calls).toEqual([["constraints"], ["constraints"]]);
    expect(agent.clearProfile).toHaveBeenCalledOnce();
    const output = streams.output();
    expect(output).toContain("Группа style сохранена в профиле «Макс».");
    expect(output).toContain("Группа constraints удалена из профиля «Макс».");
    expect(output).toContain("Группы constraints нет в профиле «Макс».");
    expect(output).toContain("Профиль «Макс» очищен. История и память пользователя сохранены.");
    expect(streams.error()).toBe("");
    expect(agent.respond).not.toHaveBeenCalled();
  });

  it.each([
    ["/profile list", "Неизвестное действие профиля «list»"],
    ["/profile load", "Не хватает аргументов. Использование: /profile load userId"],
    ["/profile load a b", "Лишние аргументы. Использование: /profile load userId"],
    ["/profile set", "Не указана группа профиля"],
    ["/profile set mood весело", "Неизвестная группа профиля «mood»"],
    ["/profile set style", "Не хватает аргументов"],
    ["/profile delete", "Не указана группа профиля"],
    ["/profile delete style extra", "Лишние аргументы"],
    ["/profile clear now", "Лишние аргументы"],
  ])("reports %s with the reason and syntax without changing anything", async (command, reason) => {
    const agent = activeAgent("Макс");
    const streams = capture(`${command}\n/exit\n`);

    await runCli(agent, [], streams.io);

    expect(streams.error()).toContain(`Ошибка · Команда не выполнена: ${reason}`);
    expect(streams.error()).toContain("Использование: /profile");
    for (const method of [agent.switchUser, agent.setProfileField, agent.deleteProfileField, agent.clearProfile]) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it("reports edits without a selected user and write failures without a false success", async () => {
    const agent = activeAgent(null);
    const noUser = new Error("Пользователь не выбран. Запустите /profile-init.");
    for (const method of [agent.setProfileField, agent.deleteProfileField, agent.clearProfile]) {
      method.mockImplementationOnce(() => {
        throw noUser;
      });
    }
    const streams = capture("/profile set style кратко\n/profile delete style\n/profile clear\nвопрос\n/exit\n");

    await runCli(agent, [], streams.io);

    expect(streams.error()).toBe(`Ошибка · Команда не выполнена: ${noUser.message}\n`.repeat(3));
    expect(streams.output()).not.toContain("сохранена");
    expect(streams.output()).not.toContain("удалена");
    expect(streams.output()).not.toContain("очищен");
    expect(agent.respond).toHaveBeenCalledExactlyOnceWith("вопрос");
  });

  it("rejects one-shot profile commands without calling the session", async () => {
    const agent = activeAgent("Макс");
    const streams = capture();
    expect(await runCli(agent, ["/profile", "load", "Владимир"], streams.io)).toBe(1);
    expect(streams.error()).toBe(
      "Ошибка · Команды доступны только в интерактивном режиме: запустите CLI без аргументов.\n",
    );
    expect(agent.switchUser).not.toHaveBeenCalled();
  });
});

describe("task commands", () => {
  const APPROVAL_PLAN = [
    "План на утверждение:",
    "  [ ] 1. Определить допустимое содержание ответа",
    "  [ ] 2. Подготовить текст клиенту",
  ];

  it("prints the saved plan after a planning turn in the task state and updates it", async () => {
    const agent = taskAgent(view());
    agent.respond
      .mockImplementationOnce(async () => {
        agent.setTask(view({ plan: ["Уточнить допустимые обещания", "Написать ответ клиенту"] }));
        return result("План готов.");
      })
      .mockImplementationOnce(async () => {
        agent.setTask(view({ plan: ["Написать ответ клиенту без сроков"] }));
        return result("План обновлён.");
      });
    const streams = capture("Продолжай\nУбери первый шаг\n/exit\n");

    await runCli(agent, [], streams.io);

    const [first, second] = streams.output().split("План обновлён.\n");
    expect(first!.split("План готов.\n")[1]).toBe(
      tokensBlock() +
        stateBlock([
          "Планирование (planning)",
          "План на утверждение:",
          "  [ ] 1. Уточнить допустимые обещания",
          "  [ ] 2. Написать ответ клиенту",
          "Далее → /task approve или попросите изменить план",
        ]) +
        "\nбез профиля [задача] > \n── Ответ агента ──\n\n",
    );
    expect(second).toContain("План на утверждение:\n  [ ] 1. Написать ответ клиенту без сроков\nДалее → /task approve");
    expect(second).not.toContain("Уточнить допустимые обещания");
    expect(agent.startTask).not.toHaveBeenCalled();
    expect(streams.error()).toBe("");
  });

  it("shows a restored plan waiting for approval at startup and after resume without the model", async () => {
    const agent = taskAgent(view({ plan: PLAN, paused: true }));
    const streams = capture("/task resume\n/exit\n");

    await runCli(agent, [], streams.io);

    expect(streams.output()).toBe(
      HEADER +
        COMMANDS_HINT +
        stateBlock(["Планирование (planning)", "На паузе", ...APPROVAL_PLAN, PAUSE_HINT]) +
        "\nбез профиля [чат, задача на паузе] > Задача возобновлена. Реплики снова идут в задачу.\n" +
        stateBlock(["Планирование (planning)", ...APPROVAL_PLAN, "Далее → /task approve или попросите изменить план"]) +
        "\nбез профиля [задача] > ",
    );
    expect(agent.respond).not.toHaveBeenCalled();
  });

  it.each([
    [
      "planning",
      view({ waitingFor: "Какой номер заказа?", paused: true }),
      "Планирование (planning)",
      "Сбор требований.",
    ],
    [
      "execution",
      view({ state: "execution", plan: PLAN, waitingFor: "Какой номер заказа?", paused: true }),
      "Выполнение (execution)",
      "Шаги: 0/2 выполнены. Сейчас шаг 1 из 2: Определить допустимое содержание ответа",
    ],
  ])("shows the saved question in %s at startup and after resume", async (_state, restored, title, progress) => {
    const agent = taskAgent(restored);
    const streams = capture("/task resume\n/exit\n");

    await runCli(agent, [], streams.io);

    const question = "Вопрос агента: Какой номер заказа?";
    expect(streams.output()).toContain(
      `${COMMANDS_HINT}${stateBlock([title, "На паузе", progress, question, PAUSE_HINT])}`,
    );
    expect(streams.output()).toContain(
      "Задача возобновлена. Реплики снова идут в задачу.\n" +
        stateBlock([title, progress, question, "Далее → ответьте на вопрос агента"]),
    );
    expect(streams.output()).not.toContain("План на утверждение");
    expect(agent.respond).not.toHaveBeenCalled();
  });

  it("prints the plan and the question once in the full /task view", async () => {
    const planned = capture("/task\n/exit\n");
    await runCli(taskAgent(view({ plan: PLAN })), [], planned.io);
    const full = planned.output().split("── Описание задачи ──")[1]!.split("без профиля [задача] > ")[0]!;
    expect(full.match(/Подготовить текст клиенту/g)).toHaveLength(1);
    expect(full).toContain(
      "\n── План ──\n\n[ ] 1. Определить допустимое содержание ответа\n[ ] 2. Подготовить текст клиенту\n",
    );
    expect(full).not.toContain("[>]");
    expect(full).not.toContain("План на утверждение");
    expect(full).toContain(
      stateBlock([
        "Планирование (planning)",
        "План предложен и ждёт утверждения.",
        "Далее → /task approve или попросите изменить план",
      ]),
    );

    const asked = capture("/task\n/exit\n");
    await runCli(taskAgent(view({ waitingFor: "Какой номер заказа?" })), [], asked.io);
    const questionView = asked.output().split("── Описание задачи ──")[1]!;
    expect(questionView.match(/Какой номер заказа\?/g)).toHaveLength(1);
    expect(questionView).toContain("\n── Вопрос агента ──\n\nКакой номер заказа?\n");
  });

  it("shows the task at startup and after a task turn, and explains the direction on pause", async () => {
    const agent = taskAgent(view({ state: "execution", plan: PLAN, results: ["первый"] }), [result("второй шаг")]);
    const streams = capture("Продолжай\n/task pause\n/exit\n");

    await runCli(agent, [], streams.io);

    const progress = "Шаги: 1/2 выполнены. Сейчас шаг 2 из 2: Подготовить текст клиенту";
    const state = stateBlock([
      "Выполнение (execution)",
      progress,
      "Далее → продолжите шаг 2, например репликой «Продолжай»",
    ]);
    const output = streams.output();
    expect(output.startsWith(`${HEADER}${COMMANDS_HINT}${state}\nбез профиля [задача] > `)).toBe(true);
    expect(output).toContain("без профиля [задача] > \n── Ответ агента ──\n\nвторой шаг\n");
    expect(output.split("второй шаг\n")[1]).toBe(
      `${tokensBlock()}${state}\nбез профиля [задача] > ` +
        "Задача приостановлена. Реплики идут в обычный чат; /task resume — вернуться к задаче.\n" +
        stateBlock(["Выполнение (execution)", "На паузе", progress, PAUSE_HINT]) +
        "\nбез профиля [чат, задача на паузе] > ",
    );
    expect(output).not.toContain("Следующая реплика");
    expect(agent.respond).toHaveBeenCalledExactlyOnceWith("Продолжай");
    expect(streams.error()).toBe("");
  });

  it("keeps chat output without the task state during a pause and prints the state in one-shot mode", async () => {
    const paused = view({ plan: PLAN, paused: true });
    const interactive = capture("вопрос в чат\n/exit\n");
    await runCli(taskAgent(paused, [result("ответ чата")]), [], interactive.io);
    expect(interactive.output().split("ответ чата\n")[1]).toBe(
      `${tokensBlock()}\nбез профиля [чат, задача на паузе] > `,
    );

    const oneShot = capture();
    await runCli(taskAgent(view({ plan: PLAN }), [result("готово")]), ["Продолжай"], oneShot.io);
    const planState = stateBlock([
      "Планирование (planning)",
      ...APPROVAL_PLAN,
      "Далее → /task approve или попросите изменить план",
    ]);
    expect(oneShot.output()).toBe(`${HEADER}${planState}\n── Ответ агента ──\n\nготово\n${tokensBlock()}${planState}`);
  });

  it("runs the commands locally with case-insensitive names and keeps the description as typed", async () => {
    const agent = taskAgent(null);
    const streams = capture(
      "/task\n/TASK Start  Ответить  «Клиенту» о Задержке \n/Task APPROVE\n/task pause\n/task pause\n" +
        "/task RESUME\n/task resume\n/task\n/task clear\n/task clear\n/exit\n",
    );

    await runCli(agent, [], streams.io);

    expect(agent.startTask).toHaveBeenCalledExactlyOnceWith("Ответить  «Клиенту» о Задержке");
    expect(agent.approveTask).toHaveBeenCalledOnce();
    expect(agent.pauseTask).toHaveBeenCalledTimes(2);
    expect(agent.resumeTask).toHaveBeenCalledTimes(2);
    expect(agent.clearTask).toHaveBeenCalledTimes(2);
    expect(agent.respond).not.toHaveBeenCalled();
    const output = streams.output();
    expect(output).toContain("без профиля > Задачи нет. Создайте её командой /task start описание.\n");
    expect(output).toContain(
      "Задача создана. Модель начнёт работу по следующей реплике, например «Продолжай».\n" +
        stateBlock([
          "Планирование (planning)",
          "Сбор требований.",
          "Далее → уточните условия или попросите составить план",
        ]),
    );
    expect(output).toContain("План утверждён. Первый шаг выполнится по следующей реплике, например «Продолжай».");
    expect(output).toContain("[задача] > Задача приостановлена.");
    expect(output).toContain("> Задача уже на паузе.\n");
    expect(output).toContain("> Задача возобновлена. Реплики снова идут в задачу.\n");
    expect(output).toContain("> Задача уже активна.\n");
    expect(output).toContain("Задача удалена. Обычный диалог, профиль и память сохранены.\n\nбез профиля > ");
    expect(output).toContain("> Задачи нет, удалять нечего.\n");
    expect(output.endsWith("без профиля > ")).toBe(true);
    expect(streams.error()).toBe("");
  });

  it("splits /task into description, plan, results, review, question and state", async () => {
    const agent = taskAgent(
      view({
        state: "execution",
        plan: PLAN,
        results: ["Нельзя обещать сроки.\nМожно извиниться."],
        waitingFor: "Как зовут клиента?",
        review: { passed: false, text: "Во втором шаге обещана компенсация." },
      }),
    );
    const streams = capture("/task\n/exit\n");

    await runCli(agent, [], streams.io);

    expect(streams.output()).toContain(
      "без профиля [задача] > \n── Описание задачи ──\n\nОтветить клиенту о задержке\n" +
        "\n── План ──\n\n[x] 1. Определить допустимое содержание ответа\n[>] 2. Подготовить текст клиенту\n" +
        "\n── Результаты шагов ──\n\nШаг 1. Определить допустимое содержание ответа\nНельзя обещать сроки.\nМожно извиниться.\n" +
        "\n── Проверка ──\n\nПроверка не пройдена, замечания:\nВо втором шаге обещана компенсация.\n" +
        "\n── Вопрос агента ──\n\nКак зовут клиента?\n" +
        stateBlock([
          "Выполнение (execution)",
          "Шаги: 1/2 выполнены. Сейчас шаг 2 из 2: Подготовить текст клиенту",
          "Последняя проверка не пройдена: шаги выполняются заново.",
          "Далее → ответьте на вопрос агента",
        ]) +
        "\nбез профиля [задача] > ",
    );

    const done = capture("/task\n/exit\n");
    await runCli(
      taskAgent(
        view({ state: "done", plan: PLAN, results: ["итог 1", "итог 2"], review: { passed: true, text: "ок" } }),
      ),
      [],
      done.io,
    );
    expect(done.output()).toContain(
      "\n── План ──\n\n[x] 1. Определить допустимое содержание ответа\n[x] 2. Подготовить текст клиенту\n",
    );
    expect(done.output()).toContain("Шаг 1. Определить допустимое содержание ответа\nитог 1\n\nШаг 2.");
    expect(done.output()).toContain(
      "\n── Проверка ──\n\nПроверка пройдена:\nок\n\n── Вопрос агента ──\n\nОткрытого вопроса нет.\n" +
        stateBlock([
          "Завершена (done)",
          "Шаги: 2/2 выполнены. Проверка пройдена.",
          "Далее → обязательных действий нет; можно обсудить результат",
        ]),
    );

    const empty = capture("/task\n/exit\n");
    await runCli(taskAgent(view()), [], empty.io);
    expect(empty.output()).toContain(
      "\n── План ──\n\nПлан ещё не предложен.\n\n── Результаты шагов ──\n\nРезультатов пока нет.\n" +
        "\n── Проверка ──\n\nСохранённой проверки нет.\n\n── Вопрос агента ──\n\nОткрытого вопроса нет.\n",
    );
  });

  it.each([
    [
      "planning with a question",
      view({ waitingFor: "Какой номер заказа?" }),
      ["Планирование (planning)", "Сбор требований.", "Вопрос агента: Какой номер заказа?"],
      "ответьте на вопрос агента",
    ],
    [
      "planning without a plan",
      view(),
      ["Планирование (planning)", "Сбор требований."],
      "уточните условия или попросите составить план",
    ],
    [
      "execution",
      view({ state: "execution", plan: PLAN }),
      ["Выполнение (execution)", "Шаги: 0/2 выполнены. Сейчас шаг 1 из 2: Определить допустимое содержание ответа"],
      "продолжите шаг 1, например репликой «Продолжай»",
    ],
    [
      "validation",
      view({ state: "validation", plan: PLAN, results: ["1", "2"] }),
      ["Проверка результатов (validation)", "Шаги: 2/2 выполнены. Ожидается проверка."],
      "отправьте «Проверь результат»",
    ],
    [
      "repeated validation",
      view({ state: "validation", plan: PLAN, results: ["1", "2"], review: { passed: false, text: "исправить" } }),
      ["Проверка результатов (validation)", "Шаги: 2/2 выполнены. Ожидается повторная проверка."],
      "отправьте «Проверь результат»",
    ],
    [
      "done",
      view({ state: "done", plan: PLAN, results: ["1", "2"], review: { passed: true, text: "ок" } }),
      ["Завершена (done)", "Шаги: 2/2 выполнены. Проверка пройдена."],
      "обязательных действий нет; можно обсудить результат",
    ],
    [
      "pause before an open question",
      view({ state: "execution", plan: PLAN, paused: true, waitingFor: "Какой номер заказа?" }),
      [
        "Выполнение (execution)",
        "На паузе",
        "Шаги: 0/2 выполнены. Сейчас шаг 1 из 2: Определить допустимое содержание ответа",
        "Вопрос агента: Какой номер заказа?",
      ],
      "/task resume, чтобы вернуться к задаче; сейчас реплики идут в обычный чат",
    ],
  ])("builds the state and next action for %s from the task view", async (_name, task, lines, action) => {
    const streams = capture("/exit\n");

    await runCli(taskAgent(task), [], streams.io);

    expect(streams.output()).toContain(stateBlock([...lines, `Далее → ${action}`]));
  });

  it.each([
    ["/task start", "Не хватает аргументов. Использование: /task start описание"],
    ["/task approve now", "Лишние аргументы. Использование: /task approve"],
    ["/task pause all", "Лишние аргументы. Использование: /task pause"],
    ["/task resume 1", "Лишние аргументы. Использование: /task resume"],
    ["/task clear all", "Лишние аргументы. Использование: /task clear"],
    ["/task list", "Неизвестное действие задачи «list». Использование: /task, /task start описание"],
  ])("reports %s with the syntax without calling the agent", async (command, reason) => {
    const agent = taskAgent(view());
    const streams = capture(`${command}\n/exit\n`);

    await runCli(agent, [], streams.io);

    expect(streams.error()).toBe(
      `Ошибка · Команда не выполнена: ${reason}${command === "/task list" ? ", /task approve, /task pause, /task resume, /task clear" : ""}\n`,
    );
    for (const method of [
      agent.respond,
      agent.startTask,
      agent.approveTask,
      agent.pauseTask,
      agent.resumeTask,
      agent.clearTask,
    ]) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it("reports failed task commands without a false success and continues", async () => {
    const agent = taskAgent(view({ plan: PLAN, paused: true }), [result("ответ")]);
    agent.approveTask.mockImplementationOnce(() => {
      throw new TaskError("Задача на паузе: сначала выполните /task resume.");
    });
    agent.startTask.mockImplementationOnce(() => {
      throw new TaskError("Незавершённую задачу нельзя заменить: сначала удалите её командой /task clear.");
    });
    agent.pauseTask.mockImplementationOnce(() => {
      throw new Error("Не удалось сохранить задачу: EACCES.");
    });
    const streams = capture("/task approve\n/task start новая\n/task pause\nвопрос\n/exit\n");

    await runCli(agent, [], streams.io);

    expect(streams.error()).toBe(
      "Ошибка · Команда не выполнена: Задача на паузе: сначала выполните /task resume.\n" +
        "Ошибка · Команда не выполнена: Незавершённую задачу нельзя заменить: сначала удалите её командой /task clear.\n" +
        "Ошибка · Команда не выполнена: Не удалось сохранить задачу: EACCES.\n",
    );
    expect(streams.output()).not.toContain("План утверждён");
    expect(streams.output()).not.toContain("Задача создана");
    expect(streams.output()).not.toContain("приостановлена");
    expect(agent.respond).toHaveBeenCalledExactlyOnceWith("вопрос");
  });

  it("keeps the task on reset and names /task clear, rejects /task in one-shot mode", async () => {
    const agent = taskAgent(view({ plan: PLAN }));
    const streams = capture("/reset\n/memory clear short\n/exit\n");
    await runCli(agent, [], streams.io);
    expect(
      streams
        .output()
        .match(new RegExp(`${RESET_MESSAGE}\nЗадача не изменена: удалить её можно командой /task clear\\.`, "g")),
    ).toHaveLength(2);
    expect(agent.clearTask).not.toHaveBeenCalled();

    const withoutTask = capture("/reset\n/exit\n");
    await runCli(fakeAgent([]), [], withoutTask.io);
    expect(withoutTask.output()).not.toContain("Задача не изменена");

    const oneShot = capture();
    expect(await runCli(agent, ["/task", "start", "описание"], oneShot.io)).toBe(1);
    expect(oneShot.error()).toBe(
      "Ошибка · Команды доступны только в интерактивном режиме: запустите CLI без аргументов.\n",
    );
    expect(agent.startTask).not.toHaveBeenCalled();
  });
});

describe("colors", () => {
  const SESSION = "/help\n/task\nПроверь результат\n/memory set working goal поездка\nсбой\n/exit\n";

  function colorAgent() {
    const reply = result("## Ответ\nготово");
    reply.finishReason = "length";
    const agent = taskAgent(
      view({ state: "validation", plan: PLAN, results: ["1", "2"], review: { passed: false, text: "исправить" } }),
    );
    agent.respond
      .mockImplementationOnce(async () => {
        agent.setTask(view({ state: "done", plan: PLAN, results: ["1", "2"], review: { passed: true, text: "ок" } }));
        return reply;
      })
      .mockRejectedValueOnce(new Error("сбой API"));
    return agent;
  }

  /** Терминал, для которого Node определяет глубину цвета сам: TERM задан, признаки CI и tmux убраны. */
  function useTerminalEnvironment(): void {
    vi.stubEnv("TERM", "xterm-256color");
    for (const name of ["CI", "TMUX", "TF_BUILD", "TEAMCITY_VERSION", "TERM_PROGRAM", "COLORTERM"]) {
      vi.stubEnv(name, undefined);
    }
  }

  async function run(terminals: { output?: Terminal; error?: Terminal }) {
    const streams = capture(SESSION, terminals);
    await runCli(colorAgent(), [], streams.io);
    return streams;
  }

  it("writes no ANSI sequences to ordinary streams and keeps the structure readable", async () => {
    const plain = await run({});

    expect(plain.output()).not.toContain(ESC);
    expect(plain.error()).not.toContain(ESC);
    expect(plain.output()).toContain("── Справка ──");
    expect(plain.output()).toContain("Завершена (done)");
    expect(plain.error()).toBe("Ошибка · Запрос не удался: сбой API\n");
  });

  it("styles a color terminal with semantic colors and resets every style on the same line", async () => {
    const plain = await run({});
    const colored = await run({ output: "color" });
    const output = colored.output();
    const heading = (title: string) => `${ESC}[36m${ESC}[1m── ${title} ──${ESC}[22m${ESC}[39m`;

    expect(stripAnsi(output)).toBe(plain.output());
    expectClosedStyles(output);
    expect(output).toContain(`${heading("Ответ агента")}\n\n## Ответ\nготово\n`);
    expect(output).toContain(`${ESC}[36m${ESC}[1mЗадача${ESC}[22m${ESC}[39m\n  ${ESC}[1m/task${ESC}[22m — показать`);
    expect(output).toContain(`${ESC}[33mГенерация остановилась по лимиту длины; ответ может быть неполным.${ESC}[39m`);
    expect(output).toContain(`${ESC}[90mХод 7 · сессия 7${ESC}[39m`);
    expect(output).toContain(`${ESC}[1mПроверка результатов (validation)${ESC}[22m`);
    expect(output).toContain(`${ESC}[32m${ESC}[1mЗавершена (done)${ESC}[22m${ESC}[39m`);
    expect(output).toContain(`${ESC}[33mДалее → обязательных действий нет; можно обсудить результат${ESC}[39m`);
    expect(output).toContain(`${ESC}[32mЗапись «goal» сохранена в working.${ESC}[39m`);
    expect(output).toContain(`\n${ESC}[35mбез профиля [задача] >${ESC}[39m `);
    expect(output).toContain(`${ESC}[35mбез профиля${ESC}[39m\n`);
  });

  it("decides colors for stdout and stderr independently", async () => {
    const coloredOutput = await run({ output: "color" });
    expect(coloredOutput.output()).toContain(ESC);
    expect(coloredOutput.error()).toBe("Ошибка · Запрос не удался: сбой API\n");

    const coloredError = await run({ error: "color" });
    expect(coloredError.output()).not.toContain(ESC);
    expect(coloredError.error()).toBe(
      `${ESC}[31m${ESC}[1mОшибка${ESC}[22m${ESC}[39m${ESC}[31m · Запрос не удался: сбой API${ESC}[39m\n`,
    );
  });

  it.each([
    ["NO_COLOR", "1"],
    ["NODE_DISABLE_COLORS", "1"],
    ["FORCE_COLOR", "0"],
  ])("turns colors off on a terminal with %s=%s", async (name, value) => {
    useTerminalEnvironment();
    const control = await run({ output: "tty", error: "tty" });
    expect(control.output()).toContain(ESC);
    expect(control.error()).toContain(ESC);

    vi.stubEnv(name, value);
    const disabled = await run({ output: "tty", error: "tty" });
    expect(disabled.output()).not.toContain(ESC);
    expect(disabled.error()).not.toContain(ESC);
    expect(disabled.output()).toBe(stripAnsi(control.output()));
  });

  it("follows FORCE_COLOR for streams that are not terminals", async () => {
    vi.stubEnv("FORCE_COLOR", "1");
    const forced = await run({});

    expect(forced.output()).toContain(`${ESC}[36m${ESC}[1m── Справка ──`);
    expect(forced.error()).toContain(`${ESC}[31m${ESC}[1mОшибка`);
  });

  it("does not pass styling to the agent, memory, profile or task", async () => {
    const agent = taskAgent(null, [result("ответ")]);
    agent.loadProfile.mockReturnValue(null);
    const streams = capture(
      "/profile-init\nМакс\nНа ты\n\nBackend\n/memory set working goal поездка\n/profile set style кратко\n" +
        "/task start описание\nвопрос\n/exit\n",
      { output: "color", error: "color" },
    );

    await runCli(agent, [], streams.io);

    expect(streams.output()).toContain(ESC);
    const calls = [agent.initProfile, agent.setMemory, agent.setProfileField, agent.startTask, agent.respond].map(
      (method) => method.mock.calls,
    );
    expect(calls).toEqual([
      [["Макс", { style: "На ты", context: "Backend" }]],
      [["working", "goal", "поездка"]],
      [["style", "кратко"]],
      [["описание"]],
      [["вопрос"]],
    ]);
  });
});

it("keeps block headings within 40 columns of a narrow terminal", async () => {
  const agent = taskAgent(
    view({ state: "execution", plan: PLAN, results: ["1"], review: { passed: false, text: "исправить" } }),
    [result("ответ")],
  );
  agent.getActiveUserId.mockReturnValue("Макс");
  agent.getContextStatus = () => ({ strategy: "branching", activeBranch: "main" });
  const streams = capture(
    "/help\n/task\n/memory\n/profile\n/branches\nвопрос\n/profile-init\nМакс\n/cancel\n/task pause\n/exit\n",
  );

  await runCli(agent, [], streams.io);

  const headings = streams
    .output()
    .split("\n")
    .filter((line) => line.startsWith("──"));
  expect(headings.length).toBeGreaterThan(10);
  for (const heading of headings) expect([...heading].length).toBeLessThanOrEqual(40);
});
