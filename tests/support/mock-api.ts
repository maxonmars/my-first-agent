import { deepStrictEqual } from "node:assert/strict";
import { LONG_TERM_MEMORY_TITLE, MEMORY_INSTRUCTION, WORKING_MEMORY_TITLE } from "../../src/memory.ts";
import { PROFILE_INSTRUCTION, PROFILE_TITLE } from "../../src/profile.ts";

const memoryBlocks = [
  { role: "user", content: `${LONG_TERM_MEMORY_TITLE}\n{"transport":"предпочитаю поезд"}` },
  { role: "user", content: `${WORKING_MEMORY_TITLE}\n{"goal":"поездка в Казань","budget":"30000 рублей"}` },
];

const profileBlocks = {
  maks: {
    role: "user",
    content: `${PROFILE_TITLE}\n{"style":"На ты, списком","constraints":"Без эмодзи","context":"Backend-разработчик"}`,
  },
  vladimir: {
    role: "user",
    content: `${PROFILE_TITLE}\n{"style":"На вы, таблицей","context":"Начинающий разработчик"}`,
  },
};

globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input);
  const method = input instanceof Request ? input.method : init?.method;
  const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
  const request = JSON.parse(String(init?.body)) as {
    model: string;
    messages: Array<{ role: string; content: string }>;
  };
  const question = request.messages.at(-1)?.content ?? "";

  if (url !== "https://api.deepseek.com/chat/completions") throw new Error(`Неожиданный URL: ${url}`);
  if (method !== "POST") throw new Error(`Неожиданный метод: ${method}`);
  if (headers.get("authorization") !== "Bearer sk-test") throw new Error("Нет ожидаемого Bearer-токена.");
  if (request.model !== "mock-model") throw new Error(`Неожиданная модель: ${request.model}`);

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

  if (question === "Проверь профиль Владимира") {
    if (!request.messages[0]?.content.endsWith(PROFILE_INSTRUCTION)) throw new Error("Нет инструкции профиля");
    deepStrictEqual(request.messages.slice(1, -1), [
      profileBlocks.vladimir,
      { role: "user", content: "Код Владимира — ДУБ" },
      { role: "assistant", content: "Эхо: Код Владимира — ДУБ" },
    ]);
    content = "Профиль Владимира получен.";
  }
  if (question === "Проверь профиль Макса") {
    if (!request.messages[0]?.content.includes(PROFILE_INSTRUCTION)) throw new Error("Нет инструкции профиля");
    deepStrictEqual(request.messages.slice(1, 5), [
      profileBlocks.maks,
      { role: "user", content: `${LONG_TERM_MEMORY_TITLE}\n{"language":"TypeScript"}` },
      { role: "user", content: "Код Макса — КЕДР" },
      { role: "assistant", content: "Эхо: Код Макса — КЕДР" },
    ]);
    content = "Профиль Макса получен.";
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
