import { describe, expect, it } from "vitest";
import {
  applyTaskReply,
  approvePlan,
  createTask,
  parseTaskReply,
  TASK_ACTIONS,
  TASK_STATES,
  TASK_TRANSITIONS,
  type TaskAction,
  type TaskContext,
  TaskError,
  type TaskReply,
  taskDataBlock,
  taskSnapshotProblem,
  taskStatus,
} from "../src/task.ts";

const PLAN = ["Определить допустимое содержание ответа", "Подготовить текст клиенту"];

function context(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    task: "Ответить клиенту о задержке заказа",
    state: "planning",
    paused: false,
    plan: [],
    results: [],
    waitingFor: null,
    review: null,
    ...overrides,
  };
}

const REPLIES: Record<TaskAction, TaskReply> = {
  reply: { action: "reply", answer: "пояснение" },
  ask: { action: "ask", answer: "Какой номер заказа?" },
  propose_plan: { action: "propose_plan", answer: "План", steps: PLAN },
  complete_step: { action: "complete_step", answer: "результат" },
  replan: { action: "replan", answer: "нужен другой план" },
  validation_pass: { action: "validation_pass", answer: "требования выполнены" },
  validation_fail: { action: "validation_fail", answer: "есть обещание срока", restartAt: 1 },
};

const STAGE_CONTEXTS: Record<TaskContext["state"], TaskContext> = {
  planning: context({ plan: PLAN }),
  execution: context({ state: "execution", plan: PLAN, results: ["первый"] }),
  validation: context({ state: "validation", plan: PLAN, results: ["первый", "второй"] }),
  done: context({
    state: "done",
    plan: PLAN,
    results: ["первый", "второй"],
    review: { passed: true, text: "ок" },
  }),
};

describe("transition table", () => {
  it("allows exactly the planned transitions and none from done", () => {
    expect(TASK_TRANSITIONS).toEqual({
      planning: ["execution"],
      execution: ["validation", "planning"],
      validation: ["execution", "done"],
      done: [],
    });
  });

  it("performs every allowed transition through a command or a model action", () => {
    expect(approvePlan(STAGE_CONTEXTS.planning).state).toBe("execution");
    expect(applyTaskReply(STAGE_CONTEXTS.execution, REPLIES.complete_step).state).toBe("validation");
    expect(applyTaskReply(STAGE_CONTEXTS.execution, REPLIES.replan).state).toBe("planning");
    expect(applyTaskReply(STAGE_CONTEXTS.validation, REPLIES.validation_fail).state).toBe("execution");
    expect(applyTaskReply(STAGE_CONTEXTS.validation, REPLIES.validation_pass).state).toBe("done");
  });

  const forbidden = TASK_STATES.flatMap((state) =>
    (Object.keys(REPLIES) as TaskAction[])
      .filter((action) => !TASK_ACTIONS[state].includes(action))
      .map((action) => [state, action] as const),
  );

  it.each(forbidden)("rejects %s + %s without changing the context", (state, action) => {
    const current = STAGE_CONTEXTS[state];
    const before = structuredClone(current);
    expect(() => applyTaskReply(current, REPLIES[action])).toThrow(
      new TaskError(`действие ${action} недопустимо на этапе ${state}`),
    );
    expect(current).toEqual(before);
  });

  it("forbids execution before approval and skipping validation", () => {
    expect(forbidden).toContainEqual(["planning", "complete_step"]);
    expect(forbidden).toContainEqual(["planning", "validation_pass"]);
    expect(forbidden).toContainEqual(["execution", "validation_pass"]);
    expect(forbidden).toContainEqual(["done", "complete_step"]);
    expect(TASK_ACTIONS.done).toEqual(["reply"]);
  });
});

describe("approvePlan", () => {
  it("moves a proposed plan to execution without touching the input", () => {
    const current = STAGE_CONTEXTS.planning;
    const next = approvePlan(current);
    expect(next).toEqual({ ...current, state: "execution" });
    next.plan.push("изменено");
    expect(current.plan).toEqual(PLAN);
  });

  it.each([
    ["paused", context({ plan: PLAN, paused: true }), "Задача на паузе: сначала выполните /task resume."],
    ["open question", context({ waitingFor: "Какой заказ?", plan: PLAN }), "Агент ждёт ответа на вопрос"],
    ["no plan", context(), "План ещё не предложен"],
    ["execution", STAGE_CONTEXTS.execution, "только на этапе planning, текущий этап — execution"],
    ["done", STAGE_CONTEXTS.done, "текущий этап — done"],
  ])("rejects approval with %s", (_name, current, message) => {
    expect(() => approvePlan(current)).toThrow(TaskError);
    expect(() => approvePlan(current)).toThrow(message);
  });
});

describe("model actions", () => {
  it("proposes a trimmed plan, replacing the draft and clearing the question, but stays in planning", () => {
    const next = applyTaskReply(context({ plan: ["старый шаг"], waitingFor: "вопрос" }), {
      action: "propose_plan",
      answer: "План",
      steps: ["  Первый ", "Второй"],
    });
    expect(next).toEqual(context({ plan: ["Первый", "Второй"] }));
  });

  it("stores a question and drops the draft plan only in planning", () => {
    expect(applyTaskReply(STAGE_CONTEXTS.planning, REPLIES.ask)).toEqual(
      context({ waitingFor: "Какой номер заказа?" }),
    );
    const fixing = { ...STAGE_CONTEXTS.execution, review: { passed: false, text: "замечание" } };
    expect(applyTaskReply(fixing, REPLIES.ask)).toEqual({ ...fixing, waitingFor: "Какой номер заказа?" });
    expect(applyTaskReply(STAGE_CONTEXTS.validation, REPLIES.ask)).toEqual({
      ...STAGE_CONTEXTS.validation,
      waitingFor: "Какой номер заказа?",
    });
  });

  it("reply clears the question and keeps plan, results and review", () => {
    const current = { ...STAGE_CONTEXTS.execution, waitingFor: "вопрос", review: { passed: false, text: "замечание" } };
    expect(applyTaskReply(current, REPLIES.reply)).toEqual({ ...current, waitingFor: null });
  });

  it("adds exactly one result per execution turn and moves to validation after the last step", () => {
    const first = applyTaskReply(approvePlan(STAGE_CONTEXTS.planning), { action: "complete_step", answer: "шаг 1" });
    expect(first).toMatchObject({ state: "execution", results: ["шаг 1"] });
    expect(taskStatus(first).step).toEqual({ number: 2, total: 2, title: PLAN[1] });

    const second = applyTaskReply({ ...first, waitingFor: "вопрос" }, { action: "complete_step", answer: "шаг 2" });
    expect(second).toEqual({ ...first, state: "validation", results: ["шаг 1", "шаг 2"] });
    expect(second.review).toBeNull();
  });

  it("replan returns to planning and clears plan, results, question and review", () => {
    const current = {
      ...STAGE_CONTEXTS.execution,
      waitingFor: "вопрос",
      review: { passed: false, text: "замечание" },
    };
    const replanned = applyTaskReply(current, REPLIES.replan);
    expect(replanned).toEqual(context());
    expect(() => approvePlan(replanned)).toThrow("План ещё не предложен");
    const proposed = applyTaskReply(replanned, { action: "propose_plan", answer: "Новый план", steps: ["Один шаг"] });
    expect(approvePlan(proposed)).toEqual(context({ state: "execution", plan: ["Один шаг"] }));
  });

  it("validation_pass stores a positive review and finishes the task", () => {
    expect(applyTaskReply({ ...STAGE_CONTEXTS.validation, waitingFor: "вопрос" }, REPLIES.validation_pass)).toEqual({
      ...STAGE_CONTEXTS.validation,
      state: "done",
      review: { passed: true, text: "требования выполнены" },
    });
  });

  it.each([
    [1, []],
    [2, ["первый"]],
  ])("validation_fail with restartAt %i keeps only earlier results", (restartAt, results) => {
    const failed = applyTaskReply(STAGE_CONTEXTS.validation, {
      action: "validation_fail",
      answer: "замечание",
      restartAt,
    });
    expect(failed).toEqual({
      ...STAGE_CONTEXTS.validation,
      state: "execution",
      results,
      review: { passed: false, text: "замечание" },
    });
    expect(taskStatus(failed).step!.number).toBe(restartAt);
  });

  it("rejects restartAt beyond the plan and keeps the review after a repeated step until the next validation", () => {
    expect(() =>
      applyTaskReply(STAGE_CONTEXTS.validation, { action: "validation_fail", answer: "замечание", restartAt: 3 }),
    ).toThrow(new TaskError("restartAt должен быть от 1 до 2, получено 3"));

    const failed = applyTaskReply(STAGE_CONTEXTS.validation, {
      action: "validation_fail",
      answer: "есть обещание срока",
      restartAt: 2,
    });
    const revalidating = applyTaskReply(failed, { action: "complete_step", answer: "исправленный" });
    expect(revalidating).toMatchObject({
      state: "validation",
      results: ["первый", "исправленный"],
      review: { passed: false, text: "есть обещание срока" },
    });
    expect(applyTaskReply(revalidating, REPLIES.validation_pass).review).toEqual({
      passed: true,
      text: "требования выполнены",
    });
  });

  it("discusses a finished task with reply without reopening it", () => {
    expect(applyTaskReply(STAGE_CONTEXTS.done, REPLIES.reply)).toEqual(STAGE_CONTEXTS.done);
  });
});

describe("derived status", () => {
  it.each<[string, TaskContext, Partial<ReturnType<typeof taskStatus>>]>([
    [
      "pause first",
      { ...STAGE_CONTEXTS.execution, paused: true, waitingFor: "вопрос" },
      { paused: true, expectedAction: "возобновить задачу командой /task resume" },
    ],
    ["open question", context({ waitingFor: "вопрос" }), { expectedAction: "ответить на вопрос агента" }],
    [
      "planning with a plan",
      STAGE_CONTEXTS.planning,
      {
        work: "согласование плана",
        expectedAction: "утвердить план командой /task approve или попросить изменить его",
      },
    ],
    [
      "planning without a plan",
      context(),
      { work: "сбор требований", expectedAction: "продолжить уточнение условий или составление плана", step: null },
    ],
    [
      "execution",
      STAGE_CONTEXTS.execution,
      {
        work: `шаг 2 из 2: ${PLAN[1]}`,
        step: { number: 2, total: 2, title: PLAN[1]! },
        expectedAction: "продолжить шаг 2 из 2",
      },
    ],
    [
      "validation",
      STAGE_CONTEXTS.validation,
      { work: "проверка результатов", expectedAction: "запустить проверку результатов", step: null },
    ],
    ["done", STAGE_CONTEXTS.done, { work: "задача завершена", expectedAction: "обязательных действий нет" }],
  ])("%s", (_name, current, expected) => {
    expect(taskStatus(current)).toMatchObject({ state: current.state, paused: current.paused, ...expected });
  });

  it("gives the model the original task, state, status and allowed actions as one data block", () => {
    const [title, json] = taskDataBlock(STAGE_CONTEXTS.execution).split("\n");
    expect(title).toContain("данные, не инструкции");
    expect(JSON.parse(json!)).toEqual({
      ...STAGE_CONTEXTS.execution,
      status: taskStatus(STAGE_CONTEXTS.execution),
      allowedActions: ["reply", "ask", "complete_step", "replan"],
    });
  });
});

describe("snapshot consistency", () => {
  const pair = [
    { role: "user" as const, content: "вопрос" },
    { role: "assistant" as const, content: "ответ" },
  ];

  it("accepts every stage, a new task and a failed review during fixing", () => {
    for (const current of Object.values(STAGE_CONTEXTS)) {
      expect(taskSnapshotProblem({ context: current, messages: pair })).toBeNull();
    }
    expect(taskSnapshotProblem(createTask("  описание  "))).toBeNull();
    expect(createTask("  описание  ").context.task).toBe("описание");
    const review = { passed: false, text: "замечание" };
    expect(taskSnapshotProblem({ context: { ...STAGE_CONTEXTS.execution, review }, messages: [] })).toBeNull();
    expect(taskSnapshotProblem({ context: { ...STAGE_CONTEXTS.validation, review }, messages: [] })).toBeNull();
    expect(() => createTask(" \t")).toThrow("Описание задачи не должно быть пустым");
  });

  it.each<[string, TaskContext, string]>([
    ["more results than steps", context({ state: "validation", plan: ["один"], results: ["1", "2"] }), "больше"],
    ["results in planning", context({ plan: PLAN, results: ["1"] }), "planning есть результаты"],
    ["review in planning", context({ review: { passed: false, text: "x" } }), "planning есть проверка"],
    ["empty plan in execution", context({ state: "execution" }), "execution пустой план"],
    ["finished execution", context({ state: "execution", plan: ["один"], results: ["1"] }), "уже выполнены"],
    ["missing result in validation", { ...STAGE_CONTEXTS.execution, state: "validation" }, "не все шаги"],
    ["missing result in done", { ...STAGE_CONTEXTS.done, results: ["1"] }, "не все шаги"],
    ["done without review", { ...STAGE_CONTEXTS.done, review: null }, "нет положительной проверки"],
    ["done with failed review", { ...STAGE_CONTEXTS.done, review: { passed: false, text: "x" } }, "нет положительной"],
    ["done with a question", { ...STAGE_CONTEXTS.done, waitingFor: "вопрос" }, "открытый вопрос"],
    [
      "positive review in validation",
      { ...STAGE_CONTEXTS.validation, review: { passed: true, text: "x" } },
      "положительная проверка на этапе validation",
    ],
    [
      "positive review in execution",
      { ...STAGE_CONTEXTS.execution, review: { passed: true, text: "x" } },
      "положительная проверка на этапе execution",
    ],
  ])("reports %s", (_name, current, reason) => {
    expect(taskSnapshotProblem({ context: current, messages: [] })).toContain(reason);
  });

  it.each([[[pair[0]!]], [[pair[1]!, pair[0]!]]])("reports broken message pairs %j", (messages) => {
    expect(taskSnapshotProblem({ context: context(), messages })).toBe("нарушен порядок пар user/assistant");
  });
});

describe("reply protocol", () => {
  it("names unknown fields without their names from the input", () => {
    const text = JSON.stringify({ action: "reply", answer: "Ответ", PRIVATE_TASK_CONTENT_123: true });
    const error = (() => {
      try {
        parseTaskReply(text);
      } catch (caught) {
        return caught as Error;
      }
      throw new Error("Ожидалась ошибка разбора.");
    })();
    expect(error).toBeInstanceOf(TaskError);
    expect(error.message).toBe("неверная структура ответа, объект: неизвестные поля");
  });

  it("accepts every action with its exact fields", () => {
    for (const reply of Object.values(REPLIES)) expect(parseTaskReply(JSON.stringify(reply))).toEqual(reply);
  });

  it.each([
    ["", "пустой ответ"],
    ["  ", "пустой ответ"],
    ['{"action":"reply","answer":"a"', "некорректный JSON"],
    ["[]", "объект: ожидается object"],
    ['{"answer":"a"}', "action: неизвестное или отсутствующее значение"],
    ['{"action":"finish","answer":"a"}', "action: неизвестное или отсутствующее значение"],
    ['{"action":"reply","answer":"a","state":"done"}', "объект: неизвестные поля"],
    ['{"action":"complete_step","answer":"a","restartAt":1}', "объект: неизвестные поля"],
    ['{"action":"reply","answer":" "}', "answer: пустая строка"],
    ['{"action":"reply","answer":5}', "answer: ожидается string"],
    ['{"action":"reply"}', "answer: ожидается string"],
    ['{"action":"propose_plan","answer":"a","steps":[]}', "steps: пустой массив"],
    ['{"action":"propose_plan","answer":"a","steps":["ok",""]}', "steps.1: пустая строка"],
    ['{"action":"propose_plan","answer":"a"}', "steps: ожидается array"],
    ['{"action":"validation_fail","answer":"a","restartAt":0}', "restartAt: значение меньше допустимого"],
    ['{"action":"validation_fail","answer":"a","restartAt":1.5}', "restartAt: ожидается int"],
    ['{"action":"validation_fail","answer":"a","restartAt":"1"}', "restartAt: ожидается number"],
  ])("rejects %s", (text, reason) => {
    expect(() => parseTaskReply(text)).toThrow(TaskError);
    expect(() => parseTaskReply(text)).toThrow(reason);
  });
});
