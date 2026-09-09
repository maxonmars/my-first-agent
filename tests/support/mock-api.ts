import { deepStrictEqual } from "node:assert/strict";

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
