import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const mockApi = fileURLToPath(new URL("./support/mock-api.ts", import.meta.url));
let workingDirectory: string;
let historyPath: string;
const RESET_MESSAGE = "Диалог выбранной стратегии и статистика очищены. Рабочая и долговременная память сохранены.";
const HEADER = "── my-first-agent ──\n\nПользователь: без профиля\nКонтекст: sliding\n";
const COMMANDS_HINT = "Команды: /help · /task · /memory · /profile\n";
const PAUSE_HINT = "Далее → /task resume, чтобы вернуться к задаче; сейчас реплики идут в обычный чат";

function stateBlock(lines: string[]): string {
  return `\n── Состояние задачи ──\n\n${lines.join("\n")}\n`;
}

beforeEach(() => {
  workingDirectory = mkdtempSync(join(tmpdir(), "my-first-agent-e2e-"));
  historyPath = join(workingDirectory, ".agent-history.sliding.json");
});

afterEach(() => rmSync(workingDirectory, { recursive: true, force: true }));

function runProcess(args: string[], input?: string, env = process.env) {
  return spawnSync(process.execPath, ["--import", mockApi, entry, ...args], {
    cwd: workingDirectory,
    env,
    input,
    encoding: "utf8",
    timeout: 20_000,
  });
}

function mockEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEEPSEEK_API_KEY: "sk-test",
    DEEPSEEK_MODEL: "mock-model",
    AGENT_CONTEXT_STRATEGY: "sliding",
    AGENT_KEEP_LAST_MESSAGES: "10",
    AGENT_MAX_INPUT_TOKENS: "",
  };
  // Вывод процесса идёт в pipe; цвет включили бы только эти переменные окружения запуска тестов.
  for (const name of ["FORCE_COLOR", "NO_COLOR", "NODE_DISABLE_COLORS"]) delete env[name];
  return env;
}

function readHistory(): unknown {
  return JSON.parse(readFileSync(historyPath, "utf8"));
}

describe("CLI process", () => {
  it("explains how to configure a missing API key", () => {
    const env = { ...process.env };
    delete env.DEEPSEEK_API_KEY;
    delete env.DEEPSEEK_MODEL;

    const result = runProcess(["вопрос"], undefined, env);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Нет DEEPSEEK_API_KEY");
    expect(result.stderr).not.toContain(" at ");
  });

  it("runs the SDK, agent and CLI without a real network request", () => {
    const result = runProcess(["проверка связи"], undefined, mockEnvironment());

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      `${HEADER}\n── Ответ агента ──\n\nЭхо: проверка связи\n` +
        "\n── Токены ──\n\nОценка ≈ вопрос 4 · контекст 16\nAPI, финал: вход 5 · генерация 3\n" +
        "Из генерации: рассуждение 1\nХод 8 · сессия 8\n",
    );
    expect(result.stderr).toBe("");
    expect(readHistory()).toEqual({
      kind: "sliding",
      messages: [
        { role: "user", content: "проверка связи" },
        { role: "assistant", content: "Эхо: проверка связи" },
      ],
    });
  });

  it("prints /help without a model call and without writing files", () => {
    const result = runProcess([], "/help\n/exit\n", mockEnvironment());

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.startsWith(`${HEADER}${COMMANDS_HINT}\nбез профиля > \n── Справка ──\n\nДиалог\n`)).toBe(true);
    expect(result.stdout).not.toContain("── Токены ──");
    expect(result.stdout).not.toContain("\u001b");
    expect(readdirSync(workingDirectory)).toEqual([]);
  });

  it("colors output under FORCE_COLOR without writing styling to history, memory, profiles or task", () => {
    const result = runProcess(
      [],
      "/profile-init\nМакс\nНа ты\n\n\n/memory set working goal поездка\n/task start Ответ клиенту о задержке\n" +
        "Продолжай\n/task pause\nвопрос в чат\n/exit\n",
      { ...mockEnvironment(), FORCE_COLOR: "1" },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "\u001b[36m\u001b[1m── Ответ агента ──\u001b[22m\u001b[39m\n\nПлан из двух шагов.\n",
    );
    expect(result.stdout).toContain("\u001b[35mМакс [чат, задача на паузе] >\u001b[39m ");
    const files = readdirSync(workingDirectory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
    expect(files.map((file) => file.split("/").at(-1)).sort()).toEqual([
      ".agent-history.sliding.json",
      ".agent-memory.working.json",
      ".agent-profiles.json",
      ".agent-task.json",
    ]);
    for (const file of files) expect(readFileSync(file, "utf8")).not.toContain("\u001b");
  });

  it("restores an interactive turn in a new one-shot process and starts token usage from zero", () => {
    const first = runProcess([], "Меня зовут Максим\n/exit\n", mockEnvironment());

    expect(first.status).toBe(0);
    expect(first.stdout).toContain("Эхо: Меня зовут Максим");
    expect(first.stderr).toBe("");

    const second = runProcess(["Как меня зовут?"], undefined, mockEnvironment());

    expect(second.status).toBe(0);
    expect(second.stdout).toContain("\n── Ответ агента ──\n\nВас зовут Максим.\n");
    expect(second.stdout).toContain("Ход 8 · сессия 8");
    expect(second.stderr).toBe("");
    expect(readHistory()).toEqual({
      kind: "sliding",
      messages: [
        { role: "user", content: "Меня зовут Максим" },
        { role: "assistant", content: "Эхо: Меня зовут Максим" },
        { role: "user", content: "Как меня зовут?" },
        { role: "assistant", content: "Вас зовут Максим." },
      ],
    });
  });

  it("keeps an empty history file after reset and sends no old context after restart", () => {
    const first = runProcess([], "Меня зовут Максим\n/reset\n/exit\n", mockEnvironment());

    expect(first.status).toBe(0);
    expect(first.stdout).toContain(RESET_MESSAGE);
    expect(first.stderr).toBe("");
    expect(readHistory()).toEqual({ kind: "sliding", messages: [] });

    const second = runProcess(["Есть ли предыдущий контекст?"], undefined, mockEnvironment());

    expect(second.status).toBe(0);
    expect(second.stdout).toContain("Предыдущих сообщений нет.");
    expect(second.stderr).toBe("");
    expect(readHistory()).toEqual({
      kind: "sliding",
      messages: [
        { role: "user", content: "Есть ли предыдущий контекст?" },
        { role: "assistant", content: "Предыдущих сообщений нет." },
      ],
    });
  });

  it("fails startup with a corrupted history file and leaves its contents unchanged", () => {
    const corrupted = '[{"role":"user","content":"личный текст"}';
    writeFileSync(historyPath, corrupted, "utf8");

    const result = runProcess(["вопрос"], undefined, mockEnvironment());

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(historyPath);
    expect(result.stderr).toContain("некорректный JSON");
    expect(result.stderr).not.toContain("личный текст");
    expect(result.stderr).not.toContain(" at ");
    expect(readFileSync(historyPath, "utf8")).toBe(corrupted);
  });
});

it("blocks growing history locally and recovers through interactive reset", () => {
  const env = { ...mockEnvironment(), AGENT_MAX_INPUT_TOKENS: "17" };
  const result = runProcess([], "abcd\nabcd\nabcd\n/reset\nabcd\n/exit\n", env);
  expect(result.status).toBe(0);
  expect(result.stdout.match(/Эхо: abcd/g)).toHaveLength(3);
  expect(result.stdout.match(/Оценка ≈ вопрос 1 · контекст 13/g)).toHaveLength(2);
  expect(result.stdout).toContain("Оценка ≈ вопрос 1 · контекст 17");
  expect(result.stderr).toMatch(/^Ошибка · Запрос не удался: .*≈ 21 токенов превышает установленный лимит 17/);
  expect(result.stdout).toContain("Ход 8 · сессия 16");
  expect(result.stdout.split(RESET_MESSAGE)[1]).toContain("Ход 8 · сессия 8");
  expect(readHistory()).toEqual({
    kind: "sliding",
    messages: [
      { role: "user", content: "abcd" },
      { role: "assistant", content: "Эхо: abcd" },
    ],
  });
  const beforeRefusal = readFileSync(historyPath, "utf8");
  const blocked = runProcess(["x".repeat(100)], undefined, env);
  expect(blocked.status).toBe(1);
  expect(blocked.stdout).toBe(HEADER);
  expect(blocked.stderr).toContain("превышает установленный лимит 17");
  expect(readFileSync(historyPath, "utf8")).toBe(beforeRefusal);
});

it("discards the old prefix on disk and restores only the window", () => {
  const env = mockEnvironment();
  const first = runProcess([], `${Array.from({ length: 11 }, (_, i) => `ход ${i + 1}`).join("\n")}\n/exit\n`, env);
  expect(first.status).toBe(0);
  expect(first.stderr).toBe("");
  expect(first.stdout).not.toContain("API, facts:");
  expect((readHistory() as { messages: unknown[] }).messages).toHaveLength(10);
  const second = runProcess(["Проверь окно"], undefined, env);
  expect(second.status).toBe(0);
  expect(second.stderr).toBe("");
  expect(second.stdout).toContain("Окно восстановлено.");
});

it("restores facts after their source leaves the window and keeps other modes and legacy files separate", () => {
  const env = { ...mockEnvironment(), AGENT_CONTEXT_STRATEGY: "facts", AGENT_KEEP_LAST_MESSAGES: "2" };
  const legacyPath = join(workingDirectory, ".agent-history.json");
  const legacy = JSON.stringify({ summary: "old summary", messages: [] });
  writeFileSync(legacyPath, legacy);
  const sliding = runProcess(["отдельный диалог"], undefined, mockEnvironment());
  expect(sliding.status).toBe(0);
  const slidingSource = readFileSync(historyPath, "utf8");
  const first = runProcess([], "Меня зовут Максим\nпромежуточный\n/exit\n", env);
  expect(first.status).toBe(0);
  expect(first.stderr).toBe("");
  expect(first.stdout).toContain("API, facts:");
  const factsPath = join(workingDirectory, ".agent-history.facts.json");
  expect(JSON.parse(readFileSync(factsPath, "utf8"))).toEqual({
    kind: "facts",
    facts: { name: "Максим" },
    messages: [
      { role: "user", content: "промежуточный" },
      { role: "assistant", content: "Эхо: промежуточный" },
    ],
  });
  const second = runProcess(["Проверь facts после перезапуска"], undefined, env);
  expect(second.status).toBe(0);
  expect(second.stderr).toBe("");
  expect(second.stdout).toContain("Facts и окно восстановлены.");
  expect(second.stdout).toContain("API, facts: вход 5 · генерация 3 · итог 8\nХод 16 · сессия 16\n");
  const reset = runProcess([], "/reset\n/exit\n", env);
  expect(reset.status).toBe(0);
  expect(JSON.parse(readFileSync(factsPath, "utf8"))).toEqual({ kind: "facts", facts: {}, messages: [] });
  expect(readFileSync(historyPath, "utf8")).toBe(slidingSource);
  expect(readFileSync(legacyPath, "utf8")).toBe(legacy);
});

it("restores active branch and checkpoint across processes, then clears all branches on reset", () => {
  const env = { ...mockEnvironment(), AGENT_CONTEXT_STRATEGY: "branching", AGENT_KEEP_LAST_MESSAGES: "2" };
  const first = runProcess(
    [],
    "общая цель\n/checkpoint\n/branch a\nсрок A\n/branch b\nсрок B\n/switch a\n/branches\n/exit\n",
    env,
  );
  expect(first.status).toBe(0);
  expect(first.stderr).toBe("");
  expect(first.stdout).toContain(
    "\n── Ветки ──\n\n- main: 2 сообщений\n* a: 4 сообщений — активная\n- b: 4 сообщений\n",
  );
  expect(first.stdout).toContain("Ход 8 · сессия 24");
  const second = runProcess(["Проверь ветку A"], undefined, env);
  expect(second.status).toBe(0);
  expect(second.stderr).toBe("");
  expect(second.stdout).toContain("Контекст: branching, ветка: a");
  expect(second.stdout).toContain("Ветка A восстановлена без B.");
  expect(second.stdout).toContain("Ход 8 · сессия 8");
  const third = runProcess([], "/branch c\nПроверь checkpoint\n/reset\n/exit\n", env);
  expect(third.status).toBe(0);
  expect(third.stderr).toBe("");
  expect(third.stdout).toContain("Checkpoint восстановлен.");
  const branchPath = join(workingDirectory, ".agent-history.branching.json");
  expect(JSON.parse(readFileSync(branchPath, "utf8"))).toEqual({
    kind: "branching",
    activeBranch: "main",
    branches: { main: [] },
    checkpoint: null,
  });
});

it("switches from full history to compression and back using one file", () => {
  const env = { ...mockEnvironment(), AGENT_CONTEXT_STRATEGY: "" };
  const legacyPath = join(workingDirectory, ".agent-history.json");
  const first = runProcess([], `${Array.from({ length: 10 }, (_, i) => `ход ${i + 1}`).join("\n")}\n/exit\n`, env);
  expect(first.status).toBe(0);
  expect(first.stderr).toBe("");
  expect(first.stdout).toContain("Контекст: без стратегии");
  expect(first.stdout).not.toContain("API, summary:");
  expect(JSON.parse(readFileSync(legacyPath, "utf8")).messages).toHaveLength(20);
  const compressed = runProcess(["ход 11"], undefined, { ...env, AGENT_CONTEXT_STRATEGY: "compression" });
  expect(compressed.status).toBe(0);
  expect(compressed.stderr).toBe("");
  expect(compressed.stdout).toContain("API, summary: вход 5 · генерация 3 · итог 8\nХод 16 · сессия 16\n");
  const saved = JSON.parse(readFileSync(legacyPath, "utf8"));
  expect(saved.summary).toBe("Факт из первых пяти ходов.");
  expect(saved.messages).toHaveLength(12);
  expect(saved).not.toHaveProperty("kind");
  const second = runProcess(["Проверь восстановленное summary"], undefined, {
    ...env,
    AGENT_CONTEXT_STRATEGY: "",
  });
  expect(second.status).toBe(0);
  expect(second.stderr).toBe("");
  expect(second.stdout).toContain("Summary и хвост восстановлены.");
  expect(second.stdout).not.toContain("API, summary:");
  expect(second.stdout).toContain("Ход 8 · сессия 8");
  const reset = runProcess([], "/reset\n/exit\n", env);
  expect(reset.status).toBe(0);
  expect(JSON.parse(readFileSync(legacyPath, "utf8"))).toEqual({ summary: null, messages: [] });
});

it("continues a legacy array with no strategy and keeps the whole history", () => {
  const env = { ...mockEnvironment(), AGENT_CONTEXT_STRATEGY: "" };
  const legacyPath = join(workingDirectory, ".agent-history.json");
  writeFileSync(
    legacyPath,
    JSON.stringify([
      { role: "user", content: "Меня зовут Максим" },
      { role: "assistant", content: "Эхо: Меня зовут Максим" },
    ]),
  );
  const result = runProcess(["Как меня зовут?"], undefined, env);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("Вас зовут Максим.");
  expect(JSON.parse(readFileSync(legacyPath, "utf8"))).toMatchObject({ summary: null, messages: expect.any(Array) });
  expect(JSON.parse(readFileSync(legacyPath, "utf8")).messages).toHaveLength(4);
});

it("persists explicit memory across processes, keeps it after reset and shares it with another strategy", () => {
  const env = mockEnvironment();
  const workingPath = join(workingDirectory, ".agent-memory.working.json");
  const longPath = join(workingDirectory, ".agent-memory.long-term.json");
  const first = runProcess(
    [],
    "/memory set working goal поездка в Казань\n/memory set working budget 30000 рублей\n" +
      "/memory set long transport предпочитаю поезд\nКод разговора — КЕДР\n/memory\n/exit\n",
    env,
  );
  expect(first.status).toBe(0);
  expect(first.stderr).toBe("");
  expect(first.stdout).toContain("Запись «transport» сохранена в long.");
  expect(first.stdout).toContain("Ход 8 · сессия 8");
  const shown = first.stdout.slice(first.stdout.indexOf("── Краткосрочная память (short) ──"));
  const [shortLayer, dictionaries] = shown.split("── Рабочая память (working) ──");
  expect(shortLayer).toContain("КЕДР");
  expect(dictionaries).not.toContain("КЕДР");
  expect(dictionaries).toContain(
    "Условия текущей задачи.\ngoal: поездка в Казань\nbudget: 30000 рублей\n\n── Долговременная память (long) ──\n\n" +
      "Сведения, предпочтения и знания.\ntransport: предпочитаю поезд\n",
  );
  expect(JSON.parse(readFileSync(workingPath, "utf8"))).toEqual({ goal: "поездка в Казань", budget: "30000 рублей" });
  expect(JSON.parse(readFileSync(longPath, "utf8"))).toEqual({ transport: "предпочитаю поезд" });
  const workingSource = readFileSync(workingPath, "utf8");
  const longSource = readFileSync(longPath, "utf8");

  const restored = runProcess(["Проверь слои памяти"], undefined, env);
  expect(restored.status).toBe(0);
  expect(restored.stderr).toBe("");
  expect(restored.stdout).toContain("Слои памяти получены.");
  expect(restored.stdout).toContain("Ход 8 · сессия 8");

  const reset = runProcess([], "/reset\n/exit\n", env);
  expect(reset.status).toBe(0);
  expect(reset.stdout).toContain(RESET_MESSAGE);
  expect(readHistory()).toEqual({ kind: "sliding", messages: [] });

  const afterReset = runProcess(["Проверь память после сброса"], undefined, env);
  expect(afterReset.status).toBe(0);
  expect(afterReset.stderr).toBe("");
  expect(afterReset.stdout).toContain("Память сохранилась без диалога.");
  const slidingSource = readFileSync(historyPath, "utf8");

  const branching = runProcess(["Проверь память в branching"], undefined, {
    ...env,
    AGENT_CONTEXT_STRATEGY: "branching",
  });
  expect(branching.status).toBe(0);
  expect(branching.stderr).toBe("");
  expect(branching.stdout).toContain("Branching получил общую память.");
  expect(readFileSync(historyPath, "utf8")).toBe(slidingSource);
  expect(
    JSON.parse(readFileSync(join(workingDirectory, ".agent-history.branching.json"), "utf8")).branches.main,
  ).toHaveLength(2);
  expect(readFileSync(workingPath, "utf8")).toBe(workingSource);
  expect(readFileSync(longPath, "utf8")).toBe(longSource);
});

it("rejects one-shot memory commands and stops on corrupted memory without exposing it", () => {
  const env = mockEnvironment();
  const workingPath = join(workingDirectory, ".agent-memory.working.json");
  const longPath = join(workingDirectory, ".agent-memory.long-term.json");

  const command = runProcess(["/memory", "set", "working", "goal", "поездка"], undefined, env);
  expect(command.status).toBe(1);
  expect(command.stderr).toBe(
    "Ошибка · Команды доступны только в интерактивном режиме: запустите CLI без аргументов.\n",
  );
  expect(existsSync(workingPath)).toBe(false);
  expect(existsSync(historyPath)).toBe(false);

  const corrupted = '{"transport":42,"note":"личное предпочтение"}';
  writeFileSync(longPath, corrupted, "utf8");
  const result = runProcess(["вопрос"], undefined, env);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/^Не удалось загрузить память long из «/);
  expect(result.stderr).toContain(longPath);
  expect(result.stderr).toMatch(
    /»: неверная структура памяти, значение записи должно быть строкой, получено number\.\n$/,
  );
  expect(result.stderr).not.toContain("личное");
  expect(readFileSync(longPath, "utf8")).toBe(corrupted);
  expect(existsSync(historyPath)).toBe(false);
});

it("creates two users, switches between them and restores the selected user's context across processes", () => {
  const env = mockEnvironment();
  const userPath = (userId: string, file: string) =>
    join(workingDirectory, ".agent-users", createHash("sha256").update(userId, "utf8").digest("hex"), file);
  const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

  const legacy = runProcess(["проверка связи"], undefined, env);
  expect(legacy.status).toBe(0);
  expect(legacy.stdout.startsWith(HEADER)).toBe(true);
  expect(existsSync(join(workingDirectory, ".agent-profiles.json"))).toBe(false);
  const legacySource = readFileSync(historyPath, "utf8");

  const first = runProcess(
    [],
    "/profile-init\nМакс\nНа ты, списком\nБез эмодзи\nBackend-разработчик\nКод Макса — КЕДР\n" +
      "/profile-init\nВладимир\nНа вы, таблицей\n\nНачинающий разработчик\nКод Владимира — ДУБ\n/exit\n",
    env,
  );
  expect(first.status).toBe(0);
  expect(first.stderr).toBe("");
  expect(first.stdout).toContain("без профиля > \n── Настройка профиля ──\n");
  expect(first.stdout).toContain(
    "Профиль «Макс» сохранён.\nПользователь: Макс\nКонтекст: sliding\n\n── Профиль «Макс» ──\n\n" +
      "style: На ты, списком\nconstraints: Без эмодзи\ncontext: Backend-разработчик\n\nМакс > ",
  );
  expect(first.stdout).toContain("Макс > \n── Ответ агента ──\n\nЭхо: Код Макса — КЕДР\n");
  expect(first.stdout).toContain("Владимир > \n── Ответ агента ──\n\nЭхо: Код Владимира — ДУБ\n");
  expect(first.stdout.match(/Ход 8 · сессия 8/g)).toHaveLength(2);
  expect(readJson(join(workingDirectory, ".agent-profiles.json"))).toEqual({
    activeUserId: "Владимир",
    profiles: {
      Макс: { style: "На ты, списком", constraints: "Без эмодзи", context: "Backend-разработчик" },
      Владимир: { style: "На вы, таблицей", context: "Начинающий разработчик" },
    },
  });
  expect(readdirSync(join(workingDirectory, ".agent-users"))).toHaveLength(2);
  expect(readJson(userPath("Макс", ".agent-history.sliding.json")).messages).toEqual([
    { role: "user", content: "Код Макса — КЕДР" },
    { role: "assistant", content: "Эхо: Код Макса — КЕДР" },
  ]);
  expect(readFileSync(historyPath, "utf8")).toBe(legacySource);

  const second = runProcess(["Проверь профиль Владимира"], undefined, env);
  expect(second.status).toBe(0);
  expect(second.stderr).toBe("");
  expect(second.stdout.startsWith("── my-first-agent ──\n\nПользователь: Владимир\nКонтекст: sliding\n\n")).toBe(true);
  expect(second.stdout).toContain("Профиль Владимира получен.");

  const third = runProcess(
    [],
    "/profile load Макс\n/memory set long language TypeScript\nПроверь профиль Макса\n/exit\n",
    env,
  );
  expect(third.status).toBe(0);
  expect(third.stderr).toBe("");
  expect(third.stdout).toContain("Владимир > Пользователь: Макс\nКонтекст: sliding\n\nМакс > ");
  expect(third.stdout).toContain("Профиль Макса получен.");
  expect(readJson(userPath("Макс", ".agent-memory.long-term.json"))).toEqual({ language: "TypeScript" });
  expect(existsSync(userPath("Владимир", ".agent-memory.long-term.json"))).toBe(false);
  expect(existsSync(join(workingDirectory, ".agent-memory.long-term.json"))).toBe(false);

  const fourth = runProcess(["Проверь профиль Макса"], undefined, env);
  expect(fourth.status).toBe(0);
  expect(fourth.stderr).toBe("");
  expect(fourth.stdout.startsWith("── my-first-agent ──\n\nПользователь: Макс\nКонтекст: sliding\n\n")).toBe(true);
  expect(fourth.stdout).toContain("Профиль Макса получен.");
  expect(fourth.stdout).toContain("Ход 8 · сессия 8");
  expect(readJson(join(workingDirectory, ".agent-profiles.json")).activeUserId).toBe("Макс");
  expect(readJson(userPath("Макс", ".agent-history.sliding.json")).messages).toHaveLength(6);
  expect(readJson(userPath("Владимир", ".agent-history.sliding.json")).messages).toHaveLength(4);
  expect(readFileSync(historyPath, "utf8")).toBe(legacySource);
});

it("runs a task through a pause, an ordinary chat and a restart, sharing it with another strategy", () => {
  const env = mockEnvironment();
  const taskPath = join(workingDirectory, ".agent-task.json");
  const plan = ["Определить допустимое содержание ответа", "Подготовить текст клиенту"];
  const readTask = () => JSON.parse(readFileSync(taskPath, "utf8"));

  const first = runProcess(
    [],
    "/task start Подготовить ответ клиенту о задержке заказа\nПродолжай\n/task approve\nПродолжай\n" +
      "/task pause\nКороткий вопрос в чат\n/exit\n",
    env,
  );
  expect(first.status).toBe(0);
  expect(first.stderr).toBe("");
  expect(first.stdout).toContain("без профиля [задача] > \n── Ответ агента ──\n\nПлан из двух шагов.\n");
  expect(first.stdout).toContain("без профиля [задача] > \n── Ответ агента ──\n\nРезультат шага 1\n");
  expect(first.stdout).toContain("без профиля [чат, задача на паузе] > \n── Ответ агента ──\n\nЧат без задачи.\n");
  expect(first.stdout).toContain("Ход 8 · сессия 24");
  expect(first.stdout).not.toContain("сессия 32");
  expect(readTask()).toEqual({
    context: {
      task: "Подготовить ответ клиенту о задержке заказа",
      state: "execution",
      paused: true,
      plan,
      results: ["Результат шага 1"],
      waitingFor: null,
      review: null,
    },
    messages: [
      { role: "user", content: "Продолжай" },
      { role: "assistant", content: "План из двух шагов." },
      { role: "user", content: "Продолжай" },
      { role: "assistant", content: "Результат шага 1" },
    ],
  });
  expect(readHistory()).toEqual({
    kind: "sliding",
    messages: [
      { role: "user", content: "Короткий вопрос в чат" },
      { role: "assistant", content: "Чат без задачи." },
    ],
  });

  const second = runProcess([], "/task resume\nПродолжай\nПроверь\n/task\n/exit\n", env);
  expect(second.status).toBe(0);
  expect(second.stderr).toBe("");
  const secondStep = "Шаги: 1/2 выполнены. Сейчас шаг 2 из 2: Подготовить текст клиенту";
  expect(second.stdout.startsWith(`${HEADER}${COMMANDS_HINT}`)).toBe(true);
  expect(second.stdout).toContain(
    `${COMMANDS_HINT}${stateBlock(["Выполнение (execution)", "На паузе", secondStep, PAUSE_HINT])}`,
  );
  expect(second.stdout).toContain(
    "Задача возобновлена. Реплики снова идут в задачу.\n" +
      stateBlock(["Выполнение (execution)", secondStep, "Далее → продолжите шаг 2, например репликой «Продолжай»"]),
  );
  expect(second.stdout).toContain("\n── Ответ агента ──\n\nРезультат шага 2\n\n── Токены ──\n");
  expect(second.stdout).toContain(
    stateBlock([
      "Проверка результатов (validation)",
      "Шаги: 2/2 выполнены. Ожидается проверка.",
      "Далее → отправьте «Проверь результат»",
    ]),
  );
  const done = stateBlock([
    "Завершена (done)",
    "Шаги: 2/2 выполнены. Проверка пройдена.",
    "Далее → обязательных действий нет; можно обсудить результат",
  ]);
  // Состояние done — после хода проверки и в конце полного /task.
  expect(second.stdout.split(done)).toHaveLength(3);
  expect(second.stdout).toContain("\n── Ответ агента ──\n\nСроков и компенсаций нет.\n\n── Токены ──\n");
  expect(second.stdout).toContain(
    "\n── План ──\n\n[x] 1. Определить допустимое содержание ответа\n[x] 2. Подготовить текст клиенту\n",
  );
  expect(second.stdout).toContain("\n── Проверка ──\n\nПроверка пройдена:\nСроков и компенсаций нет.\n");
  expect(second.stdout).toContain("Ход 8 · сессия 16");
  expect(readTask().context).toMatchObject({
    state: "done",
    paused: false,
    results: ["Результат шага 1", "Результат шага 2"],
    review: { passed: true, text: "Сроков и компенсаций нет." },
  });
  const doneSource = readFileSync(taskPath, "utf8");

  const branching = runProcess([], "/reset\n/exit\n", { ...env, AGENT_CONTEXT_STRATEGY: "branching" });
  expect(branching.status).toBe(0);
  expect(branching.stdout).toContain("Задача не изменена: удалить её можно командой /task clear.");
  expect(readFileSync(taskPath, "utf8")).toBe(doneSource);
  const discussion = runProcess(["Что в итоге?"], undefined, { ...env, AGENT_CONTEXT_STRATEGY: "branching" });
  expect(discussion.status).toBe(0);
  expect(discussion.stderr).toBe("");
  expect(discussion.stdout).toContain("Задача уже завершена.");
  expect(readTask().messages).toHaveLength(10);
  expect(readTask().context.state).toBe("done");
  expect(
    JSON.parse(readFileSync(join(workingDirectory, ".agent-history.branching.json"), "utf8")).branches.main,
  ).toEqual([]);
});

it("shows the saved plan after the turn and restart, and the saved question after resume, without the model", () => {
  const env = mockEnvironment();
  const taskPath = join(workingDirectory, ".agent-task.json");
  const plan = [
    "План на утверждение:",
    "  [ ] 1. Определить допустимое содержание ответа",
    "  [ ] 2. Подготовить текст клиенту",
  ];
  const approve = "Далее → /task approve или попросите изменить план";

  const first = runProcess([], "/task start Ответ клиенту о задержке заказа\nПродолжай\n/task pause\n/exit\n", env);
  expect(first.status).toBe(0);
  expect(first.stderr).toBe("");
  expect(first.stdout).toContain(`Ход 8 · сессия 8\n${stateBlock(["Планирование (planning)", ...plan, approve])}`);

  const second = runProcess([], "/task resume\n/exit\n", env);
  expect(second.status).toBe(0);
  expect(second.stdout).toContain(
    `${COMMANDS_HINT}${stateBlock(["Планирование (planning)", "На паузе", ...plan, PAUSE_HINT])}`,
  );
  expect(second.stdout).toContain(
    `Задача возобновлена. Реплики снова идут в задачу.\n${stateBlock(["Планирование (planning)", ...plan, approve])}`,
  );
  expect(second.stdout).not.toContain("── Токены ──");

  const saved = JSON.parse(readFileSync(taskPath, "utf8"));
  writeFileSync(
    taskPath,
    JSON.stringify({
      ...saved,
      context: { ...saved.context, plan: [], waitingFor: "Какой номер заказа?", paused: true },
    }),
  );
  const third = runProcess([], "/task resume\n/exit\n", env);
  expect(third.status).toBe(0);
  expect(third.stderr).toBe("");
  const question = "Вопрос агента: Какой номер заказа?";
  expect(third.stdout).toContain(
    stateBlock(["Планирование (planning)", "На паузе", "Сбор требований.", question, PAUSE_HINT]),
  );
  expect(third.stdout).toContain(
    "Задача возобновлена. Реплики снова идут в задачу.\n" +
      stateBlock(["Планирование (planning)", "Сбор требований.", question, "Далее → ответьте на вопрос агента"]),
  );
  expect(third.stdout).not.toContain("── Токены ──");
  expect(JSON.parse(readFileSync(taskPath, "utf8")).context).toMatchObject({
    waitingFor: "Какой номер заказа?",
    paused: false,
  });
});

it("stops on a corrupted task file without rewriting it", () => {
  const taskPath = join(workingDirectory, ".agent-task.json");
  const corrupted = '{"context":{"task":"личная задача"}';
  writeFileSync(taskPath, corrupted);

  const result = runProcess(["вопрос"], undefined, mockEnvironment());

  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/^Не удалось загрузить задачу из «.+»: некорректный JSON\.\n$/);
  expect(result.stderr).toContain(taskPath);
  expect(result.stderr).not.toContain("личная");
  expect(readFileSync(taskPath, "utf8")).toBe(corrupted);
  expect(existsSync(historyPath)).toBe(false);
});
