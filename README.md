# my-first-agent

Stateful CLI-агент для диалога с DeepSeek через OpenAI-совместимый API.

Агент — отдельная сущность: он хранит конфигурацию и историю сообщений, формирует запросы к LLM, проверяет ответы и считает токены. CLI отвечает только за пользовательский ввод и отображение `AgentResult`.

```text
CLI → Agent → OpenAI SDK → DeepSeek API
```

## Подготовка

Нужен Node.js 24+.

```bash
npm install
cp .env.example .env
```

Добавьте ключ в `.env`:

```dotenv
DEEPSEEK_API_KEY=...
DEEPSEEK_MODEL=deepseek-v4-flash
```

`.env` исключён из Git.

## Запуск

Один запрос:

```bash
npm run dev -- "Почему небо синее?"
```

Интерактивный диалог с общей историей:

```bash
npm run dev
```

Команды интерактивного режима:

- `/reset` — очистить историю и статистику агента;
- `/exit` — завершить диалог.

После каждого ответа CLI показывает токены текущего хода и накопительный расход сессии.

## Контракт агента

Публичная точка входа — `Agent.respond(input)`. Сырой ответ SDK, конфигурация и стек сообщений наружу не выдаются.

```ts
const agent = new Agent({ client: openai.chat.completions, config });
const result = await agent.respond("Меня зовут Максим");

console.log(result.text);
console.log(result.usage.turn);
console.log(result.usage.session);
```

`AgentConfig` содержит настройки одного агента:

- модель и системный промпт;
- стратегия `direct`, `steps`, `meta` или `experts`;
- формат `text`, `json`, `markdown` или `yaml`;
- лимиты слов и токенов;
- stop-маркер;
- температуру и thinking mode.

Режимы сравнения нескольких конфигураций не входят в агент: это внешние сценарии над одним или несколькими экземплярами.

История обновляется только после непустого ответа. Ошибка API не оставляет вопрос без ответа в контексте. Токены полученного, но пустого ответа учитываются, потому что API-вызов уже состоялся.

## Разработка

```bash
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run build
npm start
```

Тесты не обращаются к реальному API. Модульные тесты используют подставной LLM-клиент, а e2e-тест запускает настоящий SDK с локально подменённым HTTP-ответом.

`npm install` подключает `.githooks/pre-commit`. CI выполняет линтер, проверку типов, тесты с порогами покрытия и сборку.
