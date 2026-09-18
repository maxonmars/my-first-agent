import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Agent,
  AgentBusyError,
  type AgentConfig,
  AgentContextLimitError,
  AgentResponseError,
  type AgentResult,
} from "../src/agent.ts";
import { DEFAULT_AGENT_CONFIG } from "../src/config.ts";
import { emptyHistory, type HistoryRepository, type HistoryState } from "../src/history.ts";
import {
  INVARIANTS_INSTRUCTION,
  INVARIANTS_META_INSTRUCTION,
  type Invariant,
  invariantsBlock,
  invariantsRetryInstruction,
} from "../src/invariants.ts";
import { LONG_TERM_MEMORY_TITLE, MEMORY_INSTRUCTION, type MemoryEntries, WORKING_MEMORY_TITLE } from "../src/memory.ts";
import { type AgentProfile, PROFILE_INSTRUCTION, PROFILE_TITLE } from "../src/profile.ts";
import { jsonAgentRepositories } from "../src/session.ts";
import { SUPPORT_INVARIANTS } from "../src/support-invariants.ts";
import {
  TASK_INSTRUCTION,
  TASK_INVARIANTS_INSTRUCTION,
  TASK_META_INSTRUCTION,
  type TaskContext,
  TaskError,
  type TaskRepository,
  type TaskSnapshot,
  taskDataBlock,
  taskView,
} from "../src/task.ts";
import { type FakeReply, fakeClient, systemOf } from "./support/fake-client.ts";

const DESCRIPTION = "Подготовить ответ клиенту о задержке заказа без обещаний сроков";
const PLAN = ["Определить допустимое содержание ответа", "Подготовить текст клиенту"];

function json(reply: Record<string, unknown>, extra: FakeReply = {}): FakeReply {
  return { content: JSON.stringify(reply), totalTokens: 5, ...extra };
}

const REPLY = {
  plan: json({ action: "propose_plan", answer: "Предлагаю два шага.", steps: PLAN }),
  ask: json({ action: "ask", answer: "Известен ли номер заказа?" }),
  step1: json({ action: "complete_step", answer: "Можно: извинение и обещание сообщить новости." }),
  step2: json({ action: "complete_step", answer: "Здравствуйте! Приносим извинения за задержку." }),
  pass: json({ action: "validation_pass", answer: "Сроков и компенсаций в тексте нет." }),
  fail2: json({ action: "validation_fail", answer: "Во втором шаге обещан срок.", restartAt: 2 }),
  discuss: json({ action: "reply", answer: "Текст можно отправлять." }),
};

function task(overrides: Partial<TaskContext> = {}, messages: TaskSnapshot["messages"] = []): TaskSnapshot {
  return {
    context: {
      task: DESCRIPTION,
      state: "planning",
      paused: false,
      plan: [],
      results: [],
      waitingFor: null,
      review: null,
      ...overrides,
    },
    messages,
  };
}

interface SetupOptions {
  initial?: TaskSnapshot | null;
  replies?: Array<FakeReply | Error>;
  config?: Partial<AgentConfig>;
  history?: HistoryState;
  provider?: () => AgentProfile;
  working?: MemoryEntries;
  long?: MemoryEntries;
  invariants?: readonly Invariant[];
}

function setup({
  initial = null,
  replies = [],
  config = {},
  history,
  provider,
  working,
  long,
  invariants,
}: SetupOptions = {}) {
  const fake = fakeClient(replies);
  const state = history ?? emptyHistory("sliding");
  const historyRepository = {
    load: vi.fn<HistoryRepository["load"]>(() => structuredClone(state)),
    save: vi.fn<HistoryRepository["save"]>(),
  };
  const taskRepository = {
    load: vi.fn<TaskRepository["load"]>(() => structuredClone(initial)),
    save: vi.fn<TaskRepository["save"]>(),
  };
  const memory = (entries: MemoryEntries) => ({ load: () => structuredClone(entries), save: vi.fn() });
  const agent = new Agent({
    client: fake.client,
    config: { ...DEFAULT_AGENT_CONFIG, contextStrategy: state.kind, ...config },
    historyRepository,
    taskRepository,
    ...(provider === undefined ? {} : { profileProvider: provider }),
    ...(working === undefined ? {} : { workingMemoryRepository: memory(working) }),
    ...(long === undefined ? {} : { longTermMemoryRepository: memory(long) }),
    ...(invariants === undefined ? {} : { invariants }),
  });
  return { ...fake, agent, historyRepository, taskRepository };
}

function taskBlock(context: TaskContext) {
  return { role: "user", content: taskDataBlock(context) };
}

function pair(question: string, answer: string) {
  return [
    { role: "user" as const, content: question },
    { role: "assistant" as const, content: answer },
  ];
}

describe("task commands", () => {
  it("creates a task locally and sends the original description with the first plain reply", async () => {
    const { agent, calls, taskRepository, historyRepository } = setup({
      replies: [REPLY.plan],
      config: { stopMarker: "<END>" },
    });

    agent.startTask(`  ${DESCRIPTION}  `);

    expect(calls).toHaveLength(0);
    expect(taskRepository.save).toHaveBeenCalledExactlyOnceWith(task());
    expect(agent.getTask()).toEqual(taskView(task().context));

    const result = await agent.respond("Продолжай");

    expect(calls[0]!.messages).toEqual([
      { role: "system", content: `${DEFAULT_AGENT_CONFIG.systemPrompt}\n\n${TASK_INSTRUCTION}` },
      taskBlock(task().context),
      { role: "user", content: "Продолжай" },
    ]);
    expect(calls[0]!.response_format).toEqual({ type: "json_object" });
    expect(calls[0]).not.toHaveProperty("stop");
    expect(systemOf(calls[0]!)).not.toContain("<END>");
    expect(result.text).toBe("Предлагаю два шага.");
    expect(result.validation).toEqual({ ok: true });
    expect(result.usage).toMatchObject({ summaryCall: null, factsCall: null });
    expect(taskRepository.save).toHaveBeenLastCalledWith(
      task({ plan: PLAN }, pair("Продолжай", "Предлагаю два шага.")),
    );
    expect(historyRepository.save).not.toHaveBeenCalled();
  });

  it("rejects an empty description and replacing an unfinished or paused task, but replaces a finished one", () => {
    const { agent, taskRepository } = setup({ initial: task({ state: "execution", plan: PLAN, paused: true }) });

    expect(() => agent.startTask("  ")).toThrow(
      new TaskError("Описание задачи не должно быть пустым. Использование: /task start описание"),
    );
    expect(() => agent.startTask("Новая")).toThrow(
      "Незавершённую задачу нельзя заменить: сначала удалите её командой /task clear.",
    );
    expect(taskRepository.save).not.toHaveBeenCalled();

    const done = task({
      state: "done",
      paused: true,
      plan: PLAN,
      results: ["1", "2"],
      review: { passed: true, text: "ок" },
    });
    const finished = setup({ initial: done });
    finished.agent.startTask("Новая задача");
    expect(finished.agent.getTask()!.context).toEqual({ ...task().context, task: "Новая задача" });
  });

  it("requires a task for approve, pause and resume and treats repeated pause, resume and clear as no-ops", () => {
    const { agent, taskRepository, calls } = setup();

    for (const action of [() => agent.approveTask(), () => agent.pauseTask(), () => agent.resumeTask()]) {
      expect(action).toThrow(new TaskError("Задачи нет. Создайте её командой /task start описание."));
    }
    expect(agent.clearTask()).toBe(false);
    expect(taskRepository.save).not.toHaveBeenCalled();

    agent.startTask(DESCRIPTION);
    expect(agent.resumeTask()).toBe(false);
    expect(agent.pauseTask()).toBe(true);
    expect(agent.pauseTask()).toBe(false);
    expect(agent.getTask()!.status).toMatchObject({ paused: true, state: "planning" });
    expect(agent.resumeTask()).toBe(true);
    expect(agent.clearTask()).toBe(true);
    expect(agent.getTask()).toBeNull();
    expect(taskRepository.save.mock.calls.map(([saved]) => saved?.context.paused ?? null)).toEqual([
      false,
      true,
      false,
      null,
    ]);
    expect(calls).toHaveLength(0);
  });

  it("approves only a proposed plan without a question or pause and runs no model call", () => {
    const planned = setup({ initial: task({ plan: PLAN }) });
    planned.agent.pauseTask();
    expect(() => planned.agent.approveTask()).toThrow("Задача на паузе");
    planned.agent.resumeTask();
    planned.agent.approveTask();
    expect(planned.agent.getTask()!.status).toMatchObject({
      state: "execution",
      step: { number: 1, total: 2, title: PLAN[0] },
    });
    expect(planned.calls).toHaveLength(0);

    const asked = setup({ initial: task({ plan: PLAN, waitingFor: "Номер заказа?" }) });
    expect(() => asked.agent.approveTask()).toThrow("Агент ждёт ответа на вопрос");
    expect(asked.taskRepository.save).not.toHaveBeenCalled();
  });

  it("keeps the previous state when saving a command fails", () => {
    const failOnce = (repository: { save: ReturnType<typeof vi.fn<TaskRepository["save"]>> }) =>
      repository.save.mockImplementationOnce((snapshot) => {
        if (snapshot !== null) snapshot.context.state = "done";
        throw new Error("disk");
      });
    const { agent, taskRepository } = setup({ initial: task({ plan: PLAN }) });
    for (const action of [() => agent.approveTask(), () => agent.pauseTask(), () => agent.clearTask()]) {
      failOnce(taskRepository);
      expect(action).toThrow("disk");
    }
    expect(agent.getTask()).toEqual(taskView(task({ plan: PLAN }).context));

    const empty = setup();
    failOnce(empty.taskRepository);
    expect(() => empty.agent.startTask(DESCRIPTION)).toThrow("disk");
    expect(empty.agent.getTask()).toBeNull();
  });

  it("returns and saves detached copies", () => {
    const initial = task({ plan: [...PLAN] });
    const taskRepository = { load: () => initial, save: vi.fn<TaskRepository["save"]>() };
    const agent = new Agent({
      client: fakeClient([]).client,
      config: { ...DEFAULT_AGENT_CONFIG, contextStrategy: "sliding" },
      taskRepository,
    });
    initial.context.plan.push("изменено после загрузки");

    const view = agent.getTask()!;
    view.context.plan.push("изменено в копии");
    view.status.expectedAction = "изменено в копии";
    agent.pauseTask();
    taskRepository.save.mock.lastCall![0]!.context.plan.push("изменено после записи");

    expect(agent.getTask()).toEqual(taskView(task({ plan: PLAN, paused: true }).context));
  });
});

it("keeps the task in the agent instance without a repository", async () => {
  const fake = fakeClient([REPLY.plan]);
  const agent = new Agent({ client: fake.client, config: { ...DEFAULT_AGENT_CONFIG, contextStrategy: "sliding" } });

  agent.startTask(DESCRIPTION);
  await agent.respond("Продолжай");
  agent.approveTask();
  expect(agent.pauseTask()).toBe(true);

  expect(agent.getTask()!.context).toEqual(task({ state: "execution", paused: true, plan: PLAN }).context);
  expect(agent.clearTask()).toBe(true);
  expect(agent.getTask()).toBeNull();
});

describe("task turns", () => {
  it("sends profile, long and working memory, then the task block, the task dialog and the reply", async () => {
    const profile: AgentProfile = { style: "На вы" };
    const initial = task({ state: "execution", plan: PLAN }, pair("Продолжай", "Предлагаю два шага."));
    const { agent, calls } = setup({
      initial,
      replies: [REPLY.step1],
      provider: () => profile,
      working: { order: "A-17" },
      long: { tone: "вежливо" },
      history: { kind: "sliding", messages: pair("обычный вопрос", "обычный ответ") },
    });

    await agent.respond("Продолжай");

    expect(calls[0]!.messages).toEqual([
      {
        role: "system",
        content: `${DEFAULT_AGENT_CONFIG.systemPrompt}\n\n${PROFILE_INSTRUCTION}\n\n${MEMORY_INSTRUCTION}\n\n${TASK_INSTRUCTION}`,
      },
      { role: "user", content: `${PROFILE_TITLE}\n{"style":"На вы"}` },
      { role: "user", content: `${LONG_TERM_MEMORY_TITLE}\n{"tone":"вежливо"}` },
      { role: "user", content: `${WORKING_MEMORY_TITLE}\n{"order":"A-17"}` },
      taskBlock(initial.context),
      ...initial.messages,
      { role: "user", content: "Продолжай" },
    ]);
  });

  it("walks the whole task and stores only the answer text in the task dialog", async () => {
    const explain = json({ action: "reply", answer: "Утвердите план командой /task approve." });
    const { agent, calls, taskRepository } = setup({
      replies: [REPLY.plan, explain, REPLY.step1, REPLY.step2, REPLY.pass, REPLY.discuss],
    });
    agent.startTask(DESCRIPTION);
    await agent.respond("Продолжай");
    await agent.respond("Утверждаю");
    expect(agent.getTask()!.context).toMatchObject({ state: "planning", plan: PLAN });
    agent.approveTask();
    await agent.respond("Продолжай");
    const second = await agent.respond("Продолжай");
    expect(agent.getTask()!.status.state).toBe("validation");
    expect(second.text).toBe("Здравствуйте! Приносим извинения за задержку.");
    await agent.respond("Проверь");
    const discussion = await agent.respond("Можно отправлять?");

    const final = task(
      {
        state: "done",
        plan: PLAN,
        results: ["Можно: извинение и обещание сообщить новости.", "Здравствуйте! Приносим извинения за задержку."],
        review: { passed: true, text: "Сроков и компенсаций в тексте нет." },
      },
      [
        ...pair("Продолжай", "Предлагаю два шага."),
        ...pair("Утверждаю", "Утвердите план командой /task approve."),
        ...pair("Продолжай", "Можно: извинение и обещание сообщить новости."),
        ...pair("Продолжай", "Здравствуйте! Приносим извинения за задержку."),
        ...pair("Проверь", "Сроков и компенсаций в тексте нет."),
        ...pair("Можно отправлять?", "Текст можно отправлять."),
      ],
    );
    expect(taskRepository.save).toHaveBeenLastCalledWith(final);
    expect(discussion.text).toBe("Текст можно отправлять.");
    expect(JSON.stringify(taskRepository.save.mock.calls)).not.toContain('"action"');
    expect(calls[5]!.messages[1]).toEqual(taskBlock(final.context));
    expect(calls).toHaveLength(6);
  });

  it("keeps the failed review for the model while repeating steps from restartAt", async () => {
    const initial = task({ state: "validation", plan: PLAN, results: ["первый", "второй"] });
    const { agent, calls } = setup({ initial, replies: [REPLY.fail2, REPLY.step2] });

    await agent.respond("Проверь");
    expect(agent.getTask()!.context).toMatchObject({
      state: "execution",
      results: ["первый"],
      review: { passed: false, text: "Во втором шаге обещан срок." },
    });
    await agent.respond("Исправь");

    expect(calls[1]!.messages[1]).toEqual(
      taskBlock({
        ...initial.context,
        state: "execution",
        results: ["первый"],
        review: { passed: false, text: "Во втором шаге обещан срок." },
      }),
    );
    expect(agent.getTask()!.context).toMatchObject({ state: "validation", review: { passed: false } });
  });

  it("replans from execution and requires a new approval", async () => {
    const replan = json({ action: "replan", answer: "Нужен шаг проверки фактов." });
    const initial = task({ state: "execution", plan: PLAN, results: ["первый"] });
    const { agent } = setup({ initial, replies: [replan, REPLY.step1] });

    await agent.respond("Добавь проверку фактов");
    expect(agent.getTask()!.context).toEqual(task().context);
    expect(() => agent.approveTask()).toThrow("План ещё не предложен");
    await expect(agent.respond("Продолжай")).rejects.toThrow("действие complete_step недопустимо на этапе planning");
  });

  it("routes replies to the ordinary chat during a pause without touching the task dialog", async () => {
    const initial = task({ state: "execution", plan: PLAN }, pair("Продолжай", "план"));
    const { agent, calls, taskRepository, historyRepository } = setup({
      initial,
      replies: [{ content: "Delivery delay.", totalTokens: 4 }, REPLY.step1],
    });

    agent.pauseTask();
    const chat = await agent.respond("Как по-английски «задержка доставки»?");
    expect(calls[0]!.messages).toEqual([
      { role: "system", content: DEFAULT_AGENT_CONFIG.systemPrompt },
      { role: "user", content: "Как по-английски «задержка доставки»?" },
    ]);
    expect(calls[0]).not.toHaveProperty("response_format");
    expect(taskRepository.save).toHaveBeenCalledOnce();
    expect(historyRepository.save).toHaveBeenCalledOnce();

    agent.resumeTask();
    const resumed = await agent.respond("Продолжай");
    expect(calls[1]!.messages.slice(1)).toEqual([
      taskBlock(initial.context),
      ...initial.messages,
      { role: "user", content: "Продолжай" },
    ]);
    expect(JSON.stringify(calls[1])).not.toContain("задержка доставки");
    expect(resumed.usage.session.totalTokens).toBe(chat.usage.session.totalTokens + 5);
  });

  it("does not remove the task on reset and skips compression, window and facts for the task", async () => {
    const initial = task({ plan: PLAN });
    for (const history of [
      { kind: "compression", summary: null, messages: Array.from({ length: 10 }, () => pair("q", "a")).flat() },
      { kind: "facts", facts: { city: "Казань" }, messages: pair("q", "a") },
    ] satisfies HistoryState[]) {
      const { agent, calls, taskRepository } = setup({
        initial,
        history,
        replies: [REPLY.discuss],
        config: { historyKeepLastMessages: 2 },
      });
      agent.reset();
      expect(agent.getTask()).toEqual(taskView(initial.context));
      const result = await agent.respond("Что дальше?");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.messages.slice(1)).toEqual([
        taskBlock(initial.context),
        { role: "user", content: "Что дальше?" },
      ]);
      expect(result.usage).toMatchObject({ summaryCall: null, factsCall: null });
      expect(taskRepository.save).toHaveBeenCalledOnce();
    }
  });

  it("runs meta on the same task snapshot and keeps the static protocol in the final call", async () => {
    const initial = task({ state: "execution", plan: PLAN });
    const { agent, calls } = setup({
      initial,
      replies: [{ content: "Сформулируй вежливый ответ.", totalTokens: 3 }, REPLY.step1],
      config: { strategy: "meta" },
    });

    const result = await agent.respond("Продолжай");

    const [meta, final] = calls;
    expect(final!.messages.slice(1)).toEqual(meta!.messages.slice(1));
    expect(meta!.messages[1]).toEqual(taskBlock(initial.context));
    expect(systemOf(meta!).endsWith(TASK_META_INSTRUCTION)).toBe(true);
    expect(systemOf(meta!)).not.toContain(TASK_INSTRUCTION);
    expect(meta).not.toHaveProperty("response_format");
    expect(systemOf(final!)).toContain(`Сформулируй вежливый ответ.\n\n${TASK_INSTRUCTION}`);
    expect(final!.response_format).toEqual({ type: "json_object" });
    expect(result.usage.turn.totalTokens).toBe(8);
    expect(result.usage.finalCall.totalTokens).toBe(5);
    expect(agent.getTask()!.context.results).toHaveLength(1);
  });

  it("applies answer format and word limits to the answer field and validates it", async () => {
    const heading = json({ action: "reply", answer: "# Итог\nГотово" });
    const { agent, calls, taskRepository } = setup({
      initial: task(),
      replies: [json({ action: "reply", answer: "без заголовка" }), heading],
      config: { format: "markdown", maxWords: 50 },
    });

    await expect(agent.respond("Кратко")).rejects.toThrow(
      "Ответ модели для задачи отклонён: answer не соответствует формату markdown: нет заголовка Markdown (finish_reason: stop).",
    );
    expect(taskRepository.save).not.toHaveBeenCalled();
    await agent.respond("Кратко");

    const system = systemOf(calls[1]!);
    expect(system).toContain("Требование к тексту в поле answer: Оформи ответ в Markdown");
    expect(system).toContain("Уложи текст поля answer в 50 слов.");
    expect(system).not.toContain("Уложись в 50 слов.");
    expect(taskRepository.save).toHaveBeenCalledOnce();
  });

  it("accepts a JSON object string in answer when the configured format is json", async () => {
    const { agent } = setup({
      initial: task(),
      replies: [json({ action: "reply", answer: "[1]" }), json({ action: "reply", answer: '{"ok":true}' })],
      config: { format: "json" },
    });
    await expect(agent.respond("данные")).rejects.toThrow("на верхнем уровне ожидался объект");
    expect((await agent.respond("данные")).text).toBe('{"ok":true}');
  });
});

describe("rejected task turns", () => {
  it.each<{ name: string; reply: FakeReply; reason: string }>([
    { name: "invalid JSON", reply: { content: '{"action":"reply"', totalTokens: 7 }, reason: "некорректный JSON" },
    { name: "empty content", reply: { content: " ", totalTokens: 7 }, reason: "пустой ответ" },
    {
      name: "unknown field with private name",
      reply: json({ action: "reply", answer: "Ответ", PRIVATE_TASK_CONTENT_123: true }, { totalTokens: 7 }),
      reason: "неверная структура ответа, объект: неизвестные поля",
    },
    {
      name: "action of another stage",
      reply: json({ action: "validation_pass", answer: "готово" }, { totalTokens: 7 }),
      reason: "действие validation_pass недопустимо на этапе execution",
    },
    {
      name: "restartAt in execution",
      reply: json({ action: "complete_step", answer: "a", restartAt: 1 }, { totalTokens: 7 }),
      reason: "неверная структура ответа, объект: неизвестные поля",
    },
    {
      name: "truncated valid JSON",
      reply: json({ action: "complete_step", answer: "обрывок" }, { finishReason: "length", totalTokens: 7 }),
      reason: "ответ усечён по лимиту длины (finish_reason: length)",
    },
    {
      name: "content filter",
      reply: json({ action: "complete_step", answer: "обрывок" }, { finishReason: "content_filter", totalTokens: 7 }),
      reason: "генерация не завершилась штатно (finish_reason: content_filter)",
    },
  ])("$name: keeps the snapshot and dialog, counts usage", async ({ reply, reason }) => {
    const initial = task({ state: "execution", plan: PLAN }, pair("Продолжай", "план"));
    const { agent, calls, taskRepository } = setup({ initial, replies: [reply, REPLY.step1] });

    const refusal = agent.respond("Продолжай");
    await expect(refusal).rejects.toBeInstanceOf(AgentResponseError);
    await expect(refusal).rejects.toThrow(reason);
    await expect(refusal).rejects.not.toThrow("PRIVATE_TASK_CONTENT_123");
    expect(taskRepository.save).not.toHaveBeenCalled();
    expect(agent.getTask()).toEqual(taskView(initial.context));

    const next = await agent.respond("Ещё раз");
    expect(calls[1]!.messages.slice(1)).toEqual([
      taskBlock(initial.context),
      ...initial.messages,
      { role: "user", content: "Ещё раз" },
    ]);
    expect(next.usage.session.totalTokens).toBe(12);
  });

  it("rejects restartAt outside the plan", async () => {
    const initial = task({ state: "validation", plan: PLAN, results: ["1", "2"] });
    const { agent, taskRepository } = setup({
      initial,
      replies: [json({ action: "validation_fail", answer: "замечание", restartAt: 3 })],
    });
    await expect(agent.respond("Проверь")).rejects.toThrow("restartAt должен быть от 1 до 2, получено 3");
    expect(taskRepository.save).not.toHaveBeenCalled();
  });

  it("does not advance state or dialog when saving fails, but keeps usage", async () => {
    const initial = task({ state: "execution", plan: PLAN });
    const { agent, calls, taskRepository } = setup({ initial, replies: [REPLY.step1, REPLY.step1] });
    taskRepository.save.mockImplementationOnce((snapshot) => {
      snapshot!.context.results.push("изменено при неудачной записи");
      throw new Error("Нет места для задачи");
    });

    await expect(agent.respond("Продолжай")).rejects.toThrow("Нет места для задачи");
    expect(agent.getTask()).toEqual(taskView(initial.context));
    const next = await agent.respond("Продолжай");

    expect(calls[1]!.messages.slice(1)).toEqual([taskBlock(initial.context), { role: "user", content: "Продолжай" }]);
    expect(next.usage.session.totalTokens).toBe(10);
    expect(agent.getTask()!.context.results).toEqual(["Можно: извинение и обещание сообщить новости."]);
  });

  it("keeps usage untouched on a transport error and releases busy", async () => {
    const { agent, taskRepository } = setup({
      initial: task(),
      replies: [new Error("API недоступен"), REPLY.plan],
    });
    await expect(agent.respond("Продолжай")).rejects.toThrow("API недоступен");
    expect(taskRepository.save).not.toHaveBeenCalled();
    expect((await agent.respond("Продолжай")).usage.session.totalTokens).toBe(5);
  });

  it("counts the task in the input budget and points to /task clear instead of /reset", async () => {
    const initial = task({ state: "execution", plan: PLAN }, pair("Продолжай", "x".repeat(400)));
    const { agent, calls, taskRepository } = setup({ initial, config: { maxInputTokens: 100 }, replies: [] });

    const refusal = agent.respond("Продолжай");
    await expect(refusal).rejects.toBeInstanceOf(AgentContextLimitError);
    await expect(refusal).rejects.toThrow("Контекст задачи не сжимается автоматически, а /reset его не очищает");
    await expect(refusal).rejects.toThrow("/task clear");
    await expect(agent.respond("Продолжай")).rejects.not.toThrow("очистите историю командой /reset");
    expect(calls).toHaveLength(0);
    expect(taskRepository.save).not.toHaveBeenCalled();
    expect(() => agent.pauseTask()).not.toThrow();
  });

  it("blocks task changes for the whole turn including the save and allows reading the status", async () => {
    const { agent, taskRepository } = setup({ initial: task({ plan: PLAN }), replies: [REPLY.discuss] });
    let concurrent: Promise<AgentResult> | undefined;
    taskRepository.save.mockImplementationOnce(() => {
      for (const action of [
        () => agent.startTask("другая"),
        () => agent.approveTask(),
        () => agent.pauseTask(),
        () => agent.resumeTask(),
        () => agent.clearTask(),
      ]) {
        expect(action).toThrow(new AgentBusyError("Нельзя менять задачу во время обработки запроса."));
      }
      expect(agent.getTask()!.status.state).toBe("planning");
      concurrent = agent.respond("параллельно");
    });

    await agent.respond("Что дальше?");
    await expect(concurrent).rejects.toBeInstanceOf(AgentBusyError);
    expect(agent.pauseTask()).toBe(true);
  });
});

describe("task turns with invariants", () => {
  const [deadline, compensation] = SUPPORT_INVARIANTS.map(({ id, description }) => ({ id, description }));
  const PROMISE_STEP = json({ action: "complete_step", answer: "Мы доставим заказ завтра и вернём 2 000 рублей." });
  const REFUSAL = json({
    action: "reply",
    answer: "Не могу обещать срок и компенсацию: это нарушает NoUnconfirmedDeadline и NoCompensationPromise.",
  });
  const lastStep = task({ state: "execution", plan: PLAN, results: ["первый"] }, pair("Продолжай", "первый"));

  it("adds the block and the conflict rule to the task request and keeps JSON mode", async () => {
    const { agent, calls } = setup({
      initial: lastStep,
      replies: [REPLY.step2],
      config: { stopMarker: "<END>" },
      invariants: SUPPORT_INVARIANTS,
    });

    await agent.respond("Продолжай");

    expect(calls[0]!.messages).toEqual([
      {
        role: "system",
        content: `${DEFAULT_AGENT_CONFIG.systemPrompt}\n\n${INVARIANTS_INSTRUCTION}\n\n${TASK_INSTRUCTION}\n\n${TASK_INVARIANTS_INSTRUCTION}`,
      },
      { role: "user", content: invariantsBlock(SUPPORT_INVARIANTS) },
      taskBlock(lastStep.context),
      ...lastStep.messages,
      { role: "user", content: "Продолжай" },
    ]);
    expect(calls[0]!.response_format).toEqual({ type: "json_object" });
    expect(calls[0]).not.toHaveProperty("stop");
  });

  it("checks answer, retries from the original snapshot and commits the accepted step once", async () => {
    const { agent, calls, taskRepository } = setup({
      initial: lastStep,
      replies: [PROMISE_STEP, REPLY.step2],
      invariants: SUPPORT_INVARIANTS,
    });

    const result = await agent.respond("Продолжай");

    expect(calls).toHaveLength(2);
    expect(calls[1]!.messages.slice(1)).toEqual(calls[0]!.messages.slice(1));
    expect(calls[1]!.messages).toContainEqual(taskBlock(lastStep.context));
    expect(systemOf(calls[1]!)).toBe(
      `${systemOf(calls[0]!)}\n\n${invariantsRetryInstruction([deadline!, compensation!])}`,
    );
    expect(calls[1]!.response_format).toEqual({ type: "json_object" });
    expect(JSON.stringify(calls[1])).not.toContain("вернём");
    expect(result.text).toBe("Здравствуйте! Приносим извинения за задержку.");
    expect(result.usage.finalCall.totalTokens).toBe(5);
    expect(result.usage.turn.totalTokens).toBe(10);
    expect(taskRepository.save).toHaveBeenCalledExactlyOnceWith(
      task({ state: "validation", plan: PLAN, results: ["первый", "Здравствуйте! Приносим извинения за задержку."] }, [
        ...lastStep.messages,
        ...pair("Продолжай", "Здравствуйте! Приносим извинения за задержку."),
      ]),
    );
  });

  it("checks the steps of a proposed plan", async () => {
    const promisingPlan = json({
      action: "propose_plan",
      answer: "План из двух шагов.",
      steps: ["Извиниться за задержку", "Написать клиенту, что мы доставим заказ завтра"],
    });
    const { agent, calls, taskRepository } = setup({
      initial: task(),
      replies: [promisingPlan, REPLY.plan],
      invariants: SUPPORT_INVARIANTS,
    });

    await agent.respond("Продолжай");

    expect(calls).toHaveLength(2);
    expect(systemOf(calls[1]!)).toContain(invariantsRetryInstruction([deadline!]));
    expect(taskRepository.save).toHaveBeenCalledExactlyOnceWith(
      task({ plan: PLAN }, pair("Продолжай", "Предлагаю два шага.")),
    );
  });

  it("answers a conflicting request with reply and does not complete the step", async () => {
    const { agent, calls, taskRepository } = setup({
      initial: lastStep,
      replies: [PROMISE_STEP, REFUSAL],
      invariants: SUPPORT_INVARIANTS,
    });

    const result = await agent.respond("Пообещай доставку завтра и компенсацию");

    expect(calls).toHaveLength(2);
    expect(result.text).toContain("Не могу обещать срок и компенсацию");
    expect(agent.getTask()!.context).toEqual(lastStep.context);
    expect(taskRepository.save).toHaveBeenCalledExactlyOnceWith(
      task(lastStep.context, [
        ...lastStep.messages,
        ...pair("Пообещай доставку завтра и компенсацию", JSON.parse(String(REFUSAL.content)).answer),
      ]),
    );
  });

  it.each<{ name: string; replies: FakeReply[]; reason: string; calls: number }>([
    {
      name: "a protocol error before the invariants",
      replies: [json({ action: "validation_pass", answer: "Мы доставим заказ завтра." })],
      reason: "действие validation_pass недопустимо на этапе execution",
      calls: 1,
    },
    {
      name: "a protocol error in the retry",
      replies: [PROMISE_STEP, { content: '{"action":"reply"', totalTokens: 5 }],
      reason: "некорректный JSON",
      calls: 2,
    },
    {
      name: "a second violation",
      replies: [PROMISE_STEP, PROMISE_STEP],
      reason: "повторная генерация тоже нарушает инварианты NoUnconfirmedDeadline, NoCompensationPromise",
      calls: 2,
    },
  ])("rejects $name without advancing the task", async ({ replies, reason, calls: count }) => {
    const { agent, calls, taskRepository } = setup({ initial: lastStep, replies, invariants: SUPPORT_INVARIANTS });

    const refusal = agent.respond("Продолжай");

    await expect(refusal).rejects.toBeInstanceOf(AgentResponseError);
    await expect(refusal).rejects.toThrow(reason);
    expect(calls).toHaveLength(count);
    expect(taskRepository.save).not.toHaveBeenCalled();
    expect(agent.getTask()).toEqual(taskView(lastStep.context));
    expect(() => agent.pauseTask()).not.toThrow();
  });

  it("runs meta once with the invariants and repeats only the final task call", async () => {
    const { agent, calls } = setup({
      initial: lastStep,
      replies: [{ content: "Подготовленный промпт", totalTokens: 3 }, PROMISE_STEP, REPLY.step2],
      config: { strategy: "meta" },
      invariants: SUPPORT_INVARIANTS,
    });

    const result = await agent.respond("Продолжай");

    const [meta, first, retry] = calls;
    expect(calls).toHaveLength(3);
    expect(meta!.messages.slice(1)).toEqual(first!.messages.slice(1));
    expect(systemOf(meta!)).toContain(INVARIANTS_META_INSTRUCTION);
    expect(systemOf(meta!).endsWith(TASK_META_INSTRUCTION)).toBe(true);
    expect(systemOf(retry!).startsWith(systemOf(first!))).toBe(true);
    expect(result.usage.turn.totalTokens).toBe(13);
    expect(agent.getTask()!.status.state).toBe("validation");
  });
});

describe("task persistence across agent instances", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "agent-task-restart-"));
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function agentFor(replies: Array<FakeReply | Error>, contextStrategy: AgentConfig["contextStrategy"] = "sliding") {
    const fake = fakeClient(replies);
    const agent = new Agent({
      client: fake.client,
      config: { ...DEFAULT_AGENT_CONFIG, contextStrategy },
      ...jsonAgentRepositories(directory, contextStrategy),
    });
    return { ...fake, agent };
  }

  type Step = string | ((agent: Agent) => void);
  const scenarios: Array<{ name: string; steps: Step[]; replies: FakeReply[]; expected: Partial<TaskContext> }> = [
    {
      name: "planning with a question",
      steps: ["Продолжай"],
      replies: [REPLY.ask],
      expected: { waitingFor: "Известен ли номер заказа?" },
    },
    { name: "planning with a draft plan", steps: ["Продолжай"], replies: [REPLY.plan], expected: { plan: PLAN } },
    {
      name: "execution after the first step",
      steps: ["Продолжай", (agent) => agent.approveTask(), "Продолжай"],
      replies: [REPLY.plan, REPLY.step1],
      expected: { state: "execution", plan: PLAN, results: ["Можно: извинение и обещание сообщить новости."] },
    },
    {
      name: "paused validation",
      steps: ["Продолжай", (agent) => agent.approveTask(), "Продолжай", "Продолжай", (agent) => agent.pauseTask()],
      replies: [REPLY.plan, REPLY.step1, REPLY.step2],
      expected: { state: "validation", paused: true, plan: PLAN },
    },
    {
      name: "done",
      steps: ["Продолжай", (agent) => agent.approveTask(), "Продолжай", "Продолжай", "Проверь"],
      replies: [REPLY.plan, REPLY.step1, REPLY.step2, REPLY.pass],
      expected: { state: "done", review: { passed: true, text: "Сроков и компенсаций в тексте нет." } },
    },
  ];

  it.each(scenarios)(
    "restores $name in a new agent and continues from the saved place",
    async ({ steps, replies, expected }) => {
      const first = agentFor(replies);
      first.agent.startTask(DESCRIPTION);
      for (const step of steps) {
        if (typeof step === "string") await first.agent.respond(step);
        else step(first.agent);
      }
      const before = first.agent.getTask()!;
      expect(before.context).toMatchObject(expected);
      const saved = JSON.parse(readFileSync(join(directory, ".agent-task.json"), "utf8")) as TaskSnapshot;

      const second = agentFor([REPLY.discuss, { content: "обычный ответ" }]);
      expect(second.agent.getTask()).toEqual(before);

      await second.agent.respond("Где мы остановились?");
      if (before.context.paused) {
        expect(second.calls[0]!.messages).toEqual([
          { role: "system", content: DEFAULT_AGENT_CONFIG.systemPrompt },
          { role: "user", content: "Где мы остановились?" },
        ]);
      } else {
        expect(second.calls[0]!.messages.slice(1)).toEqual([
          taskBlock(before.context),
          ...saved.messages,
          { role: "user", content: "Где мы остановились?" },
        ]);
      }
    },
  );

  it("shares one task between context strategies and keeps the ordinary histories apart", async () => {
    const sliding = agentFor([REPLY.plan, { content: "чат sliding" }]);
    sliding.agent.startTask(DESCRIPTION);
    await sliding.agent.respond("Продолжай");
    sliding.agent.pauseTask();
    await sliding.agent.respond("вопрос в чат");
    const taskSource = readFileSync(join(directory, ".agent-task.json"), "utf8");

    const branching = agentFor([REPLY.plan], "branching");
    expect(branching.agent.getTask()).toEqual(sliding.agent.getTask());
    expect(branching.agent.getMemory().short).toEqual(emptyHistory("branching"));
    expect(readFileSync(join(directory, ".agent-task.json"), "utf8")).toBe(taskSource);
    branching.agent.resumeTask();
    await branching.agent.respond("Предложи план заново");
    expect(branching.calls[0]!.messages.slice(1, 4)).toEqual([
      taskBlock({ ...sliding.agent.getTask()!.context, paused: false }),
      ...pair("Продолжай", "Предлагаю два шага."),
    ]);
    expect(JSON.parse(readFileSync(join(directory, ".agent-history.sliding.json"), "utf8")).messages).toEqual(
      pair("вопрос в чат", "чат sliding"),
    );
  });

  it("keeps the task file unchanged after a repeated invariant violation", async () => {
    const planned = agentFor([REPLY.plan]);
    planned.agent.startTask(DESCRIPTION);
    await planned.agent.respond("Продолжай");
    planned.agent.approveTask();
    const before = readFileSync(join(directory, ".agent-task.json"), "utf8");
    const fake = fakeClient([
      json({ action: "complete_step", answer: "Мы доставим заказ завтра." }),
      json({ action: "complete_step", answer: "Заказ будет доставлен 20 сентября." }),
    ]);
    const agent = new Agent({
      client: fake.client,
      config: { ...DEFAULT_AGENT_CONFIG, contextStrategy: "sliding" },
      ...jsonAgentRepositories(directory, "sliding"),
      invariants: SUPPORT_INVARIANTS,
    });

    await expect(agent.respond("Продолжай")).rejects.toThrow("повторная генерация тоже нарушает инварианты");

    expect(fake.calls).toHaveLength(2);
    expect(readFileSync(join(directory, ".agent-task.json"), "utf8")).toBe(before);
    expect(agent.getTask()!.status).toMatchObject({ state: "execution", step: { number: 1 } });
  });

  it("fails on a corrupted task file without overwriting it", () => {
    writeFileSync(join(directory, ".agent-task.json"), '{"context":');
    expect(() => agentFor([])).toThrow("Не удалось загрузить задачу");
    expect(readFileSync(join(directory, ".agent-task.json"), "utf8")).toBe('{"context":');
  });
});
