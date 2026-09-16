import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { AgentResult } from "../src/agent.ts";
import type { CliIo, SessionPort } from "../src/cli.ts";
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

const RESET_MESSAGE = "Диалог выбранной стратегии и статистика очищены. Рабочая и долговременная память сохранены.";

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
    expect(streams.output()).toContain(RESET_MESSAGE);
    expect(streams.output()).toContain("/memory set working|long ключ значение");
    expect(streams.output()).toContain("Новая задача: /reset, затем /memory clear working.");
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
    expect(streams.output()).not.toContain(RESET_MESSAGE);
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
      working: { goal: "поездка в Казань" },
      long: { transport: "предпочитаю поезд" },
    });
    agent.deleteMemory.mockReturnValueOnce(true).mockReturnValueOnce(false);
    const streams = capture(
      "/memory\n/memory show WORKING\n/memory delete long transport\n/memory delete long transport\n" +
        "/memory clear working\n/memory clear short\n/exit\n",
    );

    await runCli(agent, [], streams.io);

    const [all, rest] = streams.output().split("Запись «transport» удалена из long.");
    const shortAt = all!.indexOf("Краткосрочная память (short)");
    const workingAt = all!.indexOf("Рабочая память (working)");
    const longAt = all!.indexOf("Долговременная память (long)");
    expect(shortAt).toBeGreaterThan(-1);
    expect(shortAt).toBeLessThan(workingAt);
    expect(workingAt).toBeLessThan(longAt);
    expect(all!.slice(shortAt, workingAt)).toContain('"content": "Код — КЕДР"');
    expect(all!.slice(workingAt, longAt)).toContain('"goal": "поездка в Казань"');
    expect(all!.slice(longAt)).toContain('"transport": "предпочитаю поезд"');
    expect(all!.slice(longAt).split("Рабочая память (working)")[1]).not.toContain("Долговременная память");
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

    expect(streams.error()).toContain(`Команда не выполнена: ${reason}`);
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
      "Команда не выполнена: Не удалось сохранить память working: ENOSPC.\nКоманда не выполнена: disk\n",
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

      expect(streams.error()).toBe("Команды доступны только в интерактивном режиме: запустите CLI без аргументов.\n");
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
    expect(output.startsWith("Пользователь: не выбран\nКонтекст: sliding\n")).toBe(true);
    expect(output).toContain("без профиля > Настройка профиля. /cancel — отменить, /exit — выйти без сохранения.");
    expect(output).toContain(
      "Укажите идентификатор пользователя, например Макс или Владимир.\nпрофиль > Новый профиль «Макс».",
    );
    expect(output).toContain("Профиль «Макс», 1/3 — style: Как с вами общаться и оформлять ответы?");
    expect(output).toContain("Подсказка: обращение, «ты» или «вы», тон");
    expect(output).toContain("Профиль «Макс», 2/3 — constraints: Какие правила соблюдать и чего избегать в ответах?");
    expect(output).toContain("Подсказка: эмодзи, код без просьбы");
    expect(output).toContain("Профиль «Макс», 3/3 — context: Что стоит знать о вас, чтобы ответы были полезнее?");
    expect(output).toContain("Подсказка: занятие, уровень опыта");
    expect(output.match(/профиль Макс > /g)).toHaveLength(3);
    expect(output).toContain("Профиль «Макс» сохранён.\nПользователь: Макс\nКонтекст: sliding\n");
    expect(output.endsWith("Макс > ")).toBe(true);
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
    expect(edited).toContain("Сейчас: На вы\nПустой ответ — оставить прежнее значение.");
    expect(edited).toContain("Сейчас: Начинающий\nПустой ответ — оставить прежнее значение.");
    expect(edited).toContain("Пустой ответ — пропустить группу.");
    expect(streams.output().endsWith("Владимир > ")).toBe(true);
  });

  it("repeats the identifier question after an invalid answer without loading or saving", async () => {
    const agent = withActiveUser(fakeAgent([]));
    const streams = capture("/profile-init\nМакс Иванов\n\n_maks\nМакс\n\n\n\n/exit\n");

    await runCli(agent, [], streams.io);

    expect(streams.error().match(/Неверный идентификатор пользователя: 1–64 символа/g)).toHaveLength(3);
    expect(streams.error().match(/Укажите идентификатор пользователя/g)).toHaveLength(3);
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
      expect(streams.output()).toContain("Настройка профиля отменена, изменения не сохранены.\nВладимир > ");
    }
  });

  it("does not run other slash commands during the wizard or store them as values", async () => {
    const agent = withActiveUser(fakeAgent([]));
    const streams = capture(
      "/profile-init\n/memory\nМакс\n/reset\n/profile load Владимир\n/profile-init\nстиль\n/checkpoint\n\n\n/exit\n",
    );

    await runCli(agent, [], streams.io);

    expect(streams.output().match(/Во время настройки профиля команды не выполняются/g)).toHaveLength(5);
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

    expect(streams.error()).toBe("Профиль не сохранён: Не удалось загрузить историю: некорректный JSON.\n");
    expect(streams.output()).not.toContain("Пользователь: Макс");
    expect(streams.output().replaceAll("профиль Макс > ", "")).not.toContain("Макс > ");
    expect(agent.respond).toHaveBeenCalledExactlyOnceWith("вопрос");
    expect(streams.output().endsWith("Владимир > ")).toBe(true);
  });

  it("rejects arguments of /profile-init and the command in one-shot mode", async () => {
    const agent = withActiveUser(fakeAgent([]), "Макс");
    const streams = capture("/PROFILE-INIT Макс\n/exit\n");
    await runCli(agent, [], streams.io);
    expect(streams.error()).toBe("Команда не выполнена: Лишние аргументы. Использование: /profile-init\n");
    expect(agent.loadProfile).not.toHaveBeenCalled();

    const oneShot = capture();
    expect(await runCli(agent, ["/profile-init"], oneShot.io)).toBe(1);
    expect(oneShot.output()).toBe("Пользователь: Макс\nКонтекст: sliding\n");
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

  it("shows the active user in the one-shot status and in the interactive prompt", async () => {
    const oneShot = capture();
    await runCli(activeAgent("Макс"), ["вопрос"], oneShot.io);
    expect(oneShot.output().startsWith("Пользователь: Макс\nКонтекст: sliding\nответ\n")).toBe(true);

    const interactive = capture("Объясни кеширование.\n/exit\n");
    await runCli(activeAgent("Макс"), [], interactive.io);
    expect(interactive.output()).toContain(
      "В branching: /checkpoint, /branch имя, /switch имя, /branches.\nМакс > ответ\n",
    );
    expect(interactive.output()).toContain("/profile set style|constraints|context значение");
  });

  it("shows the profile or suggests /profile-init without a selected user", async () => {
    const agent = activeAgent("Макс");
    agent.loadProfile.mockReturnValue({ style: "На ты", context: "Backend" });
    const streams = capture("/PROFILE\n/exit\n");
    await runCli(agent, [], streams.io);
    expect(streams.output()).toContain(
      'Профиль пользователя «Макс»:\n{\n  "style": "На ты",\n  "context": "Backend"\n}\n',
    );
    expect(agent.loadProfile).toHaveBeenCalledWith("Макс");

    const none = capture("/profile\n/exit\n");
    await runCli(activeAgent(null), [], none.io);
    expect(none.output()).toContain(
      "Пользователь: не выбран. Создайте профиль командой /profile-init.\nбез профиля > ",
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
      "Команда не выполнена: Профиль «Никто» не найден. Создайте его командой /profile-init.\n",
    );
    const output = streams.output();
    expect(output).toContain("Макс > Макс > Пользователь: Владимир\nКонтекст: sliding\nВладимир > ");
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

    expect(streams.error()).toContain(`Команда не выполнена: ${reason}`);
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

    expect(streams.error()).toBe(`Команда не выполнена: ${noUser.message}\n`.repeat(3));
    expect(streams.output()).not.toContain("сохранена");
    expect(streams.output()).not.toContain("очищен");
    expect(agent.respond).toHaveBeenCalledExactlyOnceWith("вопрос");
  });

  it("rejects one-shot profile commands without calling the session", async () => {
    const agent = activeAgent("Макс");
    const streams = capture();
    expect(await runCli(agent, ["/profile", "load", "Владимир"], streams.io)).toBe(1);
    expect(streams.error()).toBe("Команды доступны только в интерактивном режиме: запустите CLI без аргументов.\n");
    expect(agent.switchUser).not.toHaveBeenCalled();
  });
});
