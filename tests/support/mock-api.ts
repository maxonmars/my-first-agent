import { deepStrictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  INVARIANTS_INSTRUCTION,
  INVARIANTS_RETRY_TITLE,
  INVARIANTS_TITLE,
  invariantsBlock,
  invariantsRetryInstruction,
} from "../../src/invariants.ts";
import { LONG_TERM_MEMORY_TITLE, MEMORY_INSTRUCTION, WORKING_MEMORY_TITLE } from "../../src/memory.ts";
import { PROFILE_INSTRUCTION, PROFILE_TITLE } from "../../src/profile.ts";
import { SUPPORT_INVARIANTS } from "../../src/support-invariants.ts";
import { TASK_INSTRUCTION, TASK_TITLE } from "../../src/task.ts";

const memoryBlocks = [
  { role: "user", content: `${LONG_TERM_MEMORY_TITLE}\n{"transport":"предпочитаю поезд"}` },
  { role: "user", content: `${WORKING_MEMORY_TITLE}\n{"goal":"поездка в Казань","budget":"30000 рублей"}` },
];

const profileBlocks = {
  analyst: {
    role: "user",
    content: `${PROFILE_TITLE}\n{"style":"Короткий бриф списком","constraints":"Не придумывай факты","context":"Ты аналитик мероприятий"}`,
  },
  author: {
    role: "user",
    content: `${PROFILE_TITLE}\n{"style":"Живой текст анонса","context":"Ты автор анонсов"}`,
  },
};
const sharedContext = [
  { role: "user", content: `${WORKING_MEMORY_TITLE}\n{"event":"Онлайн-встреча, 40 минут"}` },
  { role: "user", content: "проверка связи" },
  { role: "assistant", content: "Эхо: проверка связи" },
  { role: "user", content: "Составь бриф" },
  { role: "assistant", content: "Эхо: Составь бриф" },
];

// Шаги docs/profile-video-prompts.md: вопрос и профиль, активный на этом шаге.
// «автор» создаётся во время сценария через /profile-init и в демо-файле не хранится.
const demoProfiles = {
  ...JSON.parse(readFileSync(new URL("../../docs/agent-profiles.demo.json", import.meta.url), "utf8")).profiles,
  автор: {
    style: "Живой дружелюбный текст анонса до 120 слов: заголовок, основной текст, призыв к действию",
    constraints:
      "Следуй согласованному брифу. Не добавляй дату, ссылку, спикеров и другие неподтверждённые факты; вместо них оставь пометку [уточнить]",
    context: "Ты автор анонсов мероприятий. Пишешь текст для публикации по согласованному брифу",
  },
};
const demoEvent = "Бесплатная онлайн-встреча «Первый агент», 40 минут, для новичков.";
const demoTurns = [
  { question: "Составь краткий бриф и предложи структуру анонса.", profileId: "аналитик" },
  { question: "Подготовь анонс по согласованному брифу.", profileId: "автор" },
  {
    question: "Проверь подготовленный анонс. Назови конкретные недочёты; если их нет — так и скажи.",
    profileId: "редактор",
  },
  {
    question: "Назови формат, длительность и аудиторию мероприятия, затем напомни результат последней проверки.",
    profileId: "редактор",
  },
];

// Шаги docs/invariants-video-prompts.md: конфликтная просьба сначала получает нарушающий ответ, повтор — отказ.
const invariantsDemo = {
  delay:
    "Подготовь вежливый ответ клиенту: заказ задерживается, точный срок пока неизвестен. Попроси номер заказа для проверки статуса.",
  conflict:
    "Напиши, что заказ точно доставят завтра. Пообещай компенсацию 2 000 рублей и попроси полный номер карты и CVV.",
  followUp: "Почему ты отказался и что можно сообщить клиенту вместо этого?",
  violating: "Заказ точно доставят завтра. Мы выплатим компенсацию 2 000 рублей. Пришлите полный номер карты и CVV.",
  refusal:
    "Не могу это написать: просьба нарушает NoUnconfirmedDeadline, NoCompensationPromise и NoPaymentCredentialsRequest. " +
    "Предлагаю сообщить клиенту, что срок уточняется, и для проверки статуса попросить номер заказа.",
};
let conflictStack: unknown;

globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  const method = input instanceof Request ? input.method : init?.method;
  const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
  const request = JSON.parse(String(init?.body)) as {
    model: string;
    messages: Array<{ role: string; content: string }>;
    response_format?: { type: string };
  };
  const question = request.messages.at(-1)?.content ?? "";

  if (url !== "https://api.deepseek.com/chat/completions") throw new Error(`Неожиданный URL: ${url}`);
  if (method !== "POST") throw new Error(`Неожиданный метод: ${method}`);
  if (headers.get("authorization") !== "Bearer sk-test") throw new Error("Нет ожидаемого Bearer-токена.");
  if (request.model !== "mock-model") throw new Error(`Неожиданная модель: ${request.model}`);

  // Рабочий агент добавляет инварианты в каждый пользовательский запрос сразу после system и профиля;
  // служебные summary и facts их не получают. Дальше проверки видят прежний стек без этого блока.
  const system = request.messages[0]?.content ?? "";
  if (system.startsWith("Кратко обнови summary") || system.startsWith("Обнови память facts")) {
    if (JSON.stringify(request).includes(INVARIANTS_TITLE)) throw new Error("Инварианты в служебном запросе");
  } else {
    if (!system.includes(INVARIANTS_INSTRUCTION)) throw new Error("Нет инструкции инвариантов");
    const at = request.messages[1]?.content.startsWith(PROFILE_TITLE) ? 2 : 1;
    deepStrictEqual(request.messages[at], { role: "user", content: invariantsBlock(SUPPORT_INVARIANTS) });
    request.messages.splice(at, 1);
  }

  let content = `Эхо: ${question}`;

  if (request.messages[0]?.content.startsWith("Кратко обнови summary")) {
    const source = JSON.parse(question);
    deepStrictEqual(source.summary, null);
    deepStrictEqual(
      source.messages,
      Array.from({ length: 5 }, (_, i) => [
        { role: "user", content: `ход ${i + 1}` },
        { role: "assistant", content: `Эхо: ход ${i + 1}` },
      ]).flat(),
    );
    content = "Факт из первых пяти ходов.";
  }
  if (question === "Проверь восстановленное summary") {
    deepStrictEqual(request.messages[1]?.role, "user");
    if (!request.messages[1]?.content.includes("Факт из первых пяти ходов.")) throw new Error("Нет summary");
    deepStrictEqual(
      request.messages.slice(2, -1),
      Array.from({ length: 6 }, (_, i) => [
        { role: "user", content: `ход ${i + 6}` },
        { role: "assistant", content: `Эхо: ход ${i + 6}` },
      ]).flat(),
    );
    content = "Summary и хвост восстановлены.";
  }

  if (request.messages[0]?.content.startsWith("Обнови память facts")) {
    const source = JSON.parse(question);
    if (source.question === "Меня зовут Максим") {
      deepStrictEqual(source.facts, {});
      deepStrictEqual(source.messages, []);
    } else {
      deepStrictEqual(source.facts, { name: "Максим" });
      deepStrictEqual(source.messages.length, 2);
    }
    content = '{"name":"Максим"}';
  }
  if (question === "Проверь facts после перезапуска") {
    deepStrictEqual(request.messages[1]?.role, "user");
    deepStrictEqual(JSON.parse(request.messages[1]!.content.split("\n")[1]!), { name: "Максим" });
    deepStrictEqual(request.messages.slice(2, -1), [
      { role: "user", content: "промежуточный" },
      { role: "assistant", content: "Эхо: промежуточный" },
    ]);
    content = "Facts и окно восстановлены.";
  }
  if (question === "Проверь ветку A") {
    deepStrictEqual(request.messages.slice(1, -1), [
      { role: "user", content: "общая цель" },
      { role: "assistant", content: "Эхо: общая цель" },
      { role: "user", content: "срок A" },
      { role: "assistant", content: "Эхо: срок A" },
    ]);
    content = "Ветка A восстановлена без B.";
  }
  if (question === "Проверь checkpoint") {
    deepStrictEqual(request.messages.slice(1, -1), [
      { role: "user", content: "общая цель" },
      { role: "assistant", content: "Эхо: общая цель" },
    ]);
    content = "Checkpoint восстановлен.";
  }
  if (question === "Проверь окно") {
    deepStrictEqual(
      request.messages.slice(1, -1),
      Array.from({ length: 5 }, (_, i) => [
        { role: "user", content: `ход ${i + 7}` },
        { role: "assistant", content: `Эхо: ход ${i + 7}` },
      ]).flat(),
    );
    content = "Окно восстановлено.";
  }

  if (question === "Проверь слои памяти") {
    if (!request.messages[0]?.content.endsWith(MEMORY_INSTRUCTION)) throw new Error("Нет инструкции памяти");
    deepStrictEqual(request.messages.slice(1, -1), [
      ...memoryBlocks,
      { role: "user", content: "Код разговора — КЕДР" },
      { role: "assistant", content: "Эхо: Код разговора — КЕДР" },
    ]);
    content = "Слои памяти получены.";
  }
  if (question === "Проверь память после сброса" || question === "Проверь память в branching") {
    deepStrictEqual(request.messages.slice(1, -1), memoryBlocks);
    content = question.endsWith("branching") ? "Branching получил общую память." : "Память сохранилась без диалога.";
  }

  if (question === "Проверь роль автора") {
    if (!request.messages[0]?.content.includes(PROFILE_INSTRUCTION)) throw new Error("Нет инструкции профиля");
    deepStrictEqual(request.messages.slice(1, -1), [profileBlocks.author, ...sharedContext]);
    content = "Автор получил общий контекст.";
  }
  if (question === "Проверь роль аналитика") {
    if (!request.messages[0]?.content.includes(PROFILE_INSTRUCTION)) throw new Error("Нет инструкции профиля");
    deepStrictEqual(request.messages.slice(1, -1), [
      profileBlocks.analyst,
      ...sharedContext,
      { role: "user", content: "Проверь роль автора" },
      { role: "assistant", content: "Автор получил общий контекст." },
    ]);
    content = "Аналитик получил общий контекст.";
  }

  const demoIndex = demoTurns.findIndex((turn) => turn.question === question);
  if (demoIndex >= 0) {
    if (!request.messages[0]?.content.includes(PROFILE_INSTRUCTION)) throw new Error("Нет инструкции профиля");
    deepStrictEqual(request.messages.slice(1, -1), [
      { role: "user", content: `${PROFILE_TITLE}\n${JSON.stringify(demoProfiles[demoTurns[demoIndex]!.profileId])}` },
      { role: "user", content: `${WORKING_MEMORY_TITLE}\n${JSON.stringify({ event: demoEvent })}` },
      ...demoTurns.slice(0, demoIndex).flatMap((turn) => [
        { role: "user", content: turn.question },
        { role: "assistant", content: `Эхо: ${turn.question}` },
      ]),
    ]);
  }

  if (request.messages[0]?.content.includes(TASK_INSTRUCTION)) {
    const blockIndex = request.messages.findIndex((message) => message.content.startsWith(TASK_TITLE));
    const task = JSON.parse(request.messages[blockIndex]!.content.slice(TASK_TITLE.length + 1));
    const dialog = request.messages.slice(blockIndex + 1, -1);
    deepStrictEqual(request.response_format, { type: "json_object" });
    if (!task.task.includes("задерж")) throw new Error("Нет исходного описания задачи");
    for (const result of task.results) {
      if (!dialog.some((message) => message.role === "assistant" && message.content === result)) {
        throw new Error("Результат шага не найден в переписке задачи");
      }
    }
    const reply = {
      planning: {
        action: "propose_plan",
        answer: "План из двух шагов.",
        steps: ["Определить допустимое содержание ответа", "Подготовить текст клиенту"],
      },
      execution: { action: "complete_step", answer: `Результат шага ${task.status.step?.number}` },
      validation: { action: "validation_pass", answer: "Сроков и компенсаций нет." },
      done: { action: "reply", answer: "Задача уже завершена." },
    }[task.state as string];
    content = JSON.stringify(reply);
  }
  if (question === "Короткий вопрос в чат") {
    deepStrictEqual(request.messages.slice(1), [{ role: "user", content: question }]);
    content = "Чат без задачи.";
  }

  if (question === invariantsDemo.conflict) {
    if (system.includes(INVARIANTS_RETRY_TITLE)) {
      if (!system.endsWith(invariantsRetryInstruction(SUPPORT_INVARIANTS.slice(0, 3)))) {
        throw new Error("Повтор не называет нарушенные инварианты");
      }
      if (JSON.stringify(request).includes("выплатим")) throw new Error("Отклонённый ответ попал в повторный запрос");
      deepStrictEqual(request.messages.slice(1), conflictStack);
      content = invariantsDemo.refusal;
    } else {
      conflictStack = request.messages.slice(1);
      content = invariantsDemo.violating;
    }
  }
  if (question === invariantsDemo.followUp) {
    deepStrictEqual(request.messages.slice(1, -1), [
      { role: "user", content: invariantsDemo.delay },
      { role: "assistant", content: `Эхо: ${invariantsDemo.delay}` },
      { role: "user", content: invariantsDemo.conflict },
      { role: "assistant", content: invariantsDemo.refusal },
    ]);
  }

  if (question === "Как меня зовут?") {
    deepStrictEqual(request.messages.slice(1), [
      { role: "user", content: "Меня зовут Максим" },
      { role: "assistant", content: "Эхо: Меня зовут Максим" },
      { role: "user", content: "Как меня зовут?" },
    ]);
    content = "Вас зовут Максим.";
  }

  if (question === "Есть ли предыдущий контекст?") {
    deepStrictEqual(request.messages.slice(1), [{ role: "user", content: "Есть ли предыдущий контекст?" }]);
    content = "Предыдущих сообщений нет.";
  }

  return new Response(
    JSON.stringify({
      id: "mock-completion",
      object: "chat.completion",
      created: 0,
      model: "mock-model",
      choices: [
        {
          index: 0,
          logprobs: null,
          finish_reason: "stop",
          message: { role: "assistant", content, refusal: null },
        },
      ],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 3,
        total_tokens: 8,
        completion_tokens_details: { reasoning_tokens: 1 },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};
