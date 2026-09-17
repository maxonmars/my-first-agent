import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonTaskRepository } from "../src/json-task-repository.ts";
import type { TaskSnapshot } from "../src/task.ts";

let directory: string;
let filePath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "agent-task-"));
  filePath = join(directory, "nested", ".agent-task.json");
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

function snapshot(): TaskSnapshot {
  return {
    context: {
      task: "Ответить клиенту о задержке заказа",
      state: "execution",
      paused: true,
      plan: ["Определить содержание", "Подготовить текст"],
      results: ["Нельзя обещать сроки"],
      waitingFor: "Как зовут клиента?",
      review: { passed: false, text: "В тексте есть обещание срока" },
    },
    messages: [
      { role: "user", content: "Продолжай" },
      { role: "assistant", content: "Нельзя обещать сроки" },
    ],
  };
}

function writeRaw(value: unknown): string {
  mkdirSync(join(directory, "nested"), { recursive: true });
  const source = typeof value === "string" ? value : JSON.stringify(value);
  writeFileSync(filePath, source);
  return source;
}

describe("JsonTaskRepository", () => {
  it("returns null for a missing file and for a saved empty task", () => {
    const repository = new JsonTaskRepository(filePath);
    expect(repository.load()).toBeNull();

    repository.save(null);
    expect(readFileSync(filePath, "utf8")).toBe("null");
    expect(repository.load()).toBeNull();
  });

  it("round-trips state, pause, question, review and messages in one file, creating the directory", () => {
    const repository = new JsonTaskRepository(filePath);
    const saved = snapshot();

    repository.save(saved);

    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual(snapshot());
    expect(readdirSync(join(directory, "nested"))).toEqual([".agent-task.json"]);
    expect(new JsonTaskRepository(filePath).load()).toEqual(snapshot());
  });

  it("returns independent nested objects from every load and keeps the file after the input changes", () => {
    const repository = new JsonTaskRepository(filePath);
    const saved = snapshot();
    repository.save(saved);
    saved.context.plan.push("изменено после записи");
    saved.messages[0]!.content = "изменено после записи";

    const first = repository.load()!;
    first.context.results.push("изменено после чтения");
    first.context.review!.text = "изменено после чтения";

    expect(repository.load()).toEqual(snapshot());
  });

  it.each([
    ["invalid JSON", '{"context":', "некорректный JSON"],
    ["array", [], "неверная структура задачи, объект: ожидается object"],
    ["unknown field", { ...snapshot(), archive: [] }, "неверная структура задачи, объект: неизвестные поля"],
    [
      "unknown state",
      { ...snapshot(), context: { ...snapshot().context, state: "review" } },
      "context.state: неизвестное или отсутствующее значение",
    ],
    ["missing pause", { ...snapshot(), context: { ...snapshot().context, paused: undefined } }, "context.paused"],
    [
      "blank description",
      { ...snapshot(), context: { ...snapshot().context, task: "  " } },
      "context.task: пустая строка",
    ],
    [
      "blank plan step",
      { ...snapshot(), context: { ...snapshot().context, plan: ["шаг", " "] } },
      "context.plan.1: пустая строка",
    ],
    [
      "blank result",
      { ...snapshot(), context: { ...snapshot().context, results: [""] } },
      "context.results.0: пустая строка",
    ],
    [
      "review without text",
      { ...snapshot(), context: { ...snapshot().context, review: { passed: true } } },
      "context.review.text: ожидается string",
    ],
    [
      "unfinished message pair",
      { ...snapshot(), messages: [{ role: "user", content: "Продолжай" }] },
      "несогласованное состояние задачи, нарушен порядок пар user/assistant",
    ],
    [
      "done without positive review",
      {
        ...snapshot(),
        context: { ...snapshot().context, state: "done", results: ["1", "2"], waitingFor: null },
      },
      "несогласованное состояние задачи, на этапе done нет положительной проверки",
    ],
  ])("reports %s with the path and reason without task text", (_name, value, reason) => {
    const source = writeRaw(value);
    const repository = new JsonTaskRepository(filePath);

    const error = (() => {
      try {
        repository.load();
      } catch (caught) {
        return caught as Error;
      }
      throw new Error("Ожидалась ошибка загрузки.");
    })();

    expect(error.message).toContain(`Не удалось загрузить задачу из «${filePath}»`);
    expect(error.message).toContain(reason);
    expect(error.message).not.toContain("клиент");
    expect(readFileSync(filePath, "utf8")).toBe(source);
  });

  it("does not reveal names of unknown fields and keeps the file", () => {
    const source = writeRaw({ ...snapshot(), context: { ...snapshot().context, PRIVATE_TASK_CONTENT_123: true } });

    expect(() => new JsonTaskRepository(filePath).load()).toThrow(
      `Не удалось загрузить задачу из «${filePath}»: неверная структура задачи, context: неизвестные поля.`,
    );
    expect(() => new JsonTaskRepository(filePath).load()).not.toThrow("PRIVATE_TASK_CONTENT_123");
    expect(readFileSync(filePath, "utf8")).toBe(source);
  });

  it("reports read errors other than a missing file", () => {
    mkdirSync(filePath, { recursive: true });
    expect(() => new JsonTaskRepository(filePath).load()).toThrow(/ошибка чтения файла \(EISDIR\)/);
  });

  it("rejects an inconsistent snapshot before writing and keeps the previous file", () => {
    const repository = new JsonTaskRepository(filePath);
    repository.save(snapshot());
    const before = readFileSync(filePath, "utf8");
    const broken = snapshot();
    broken.context.results = ["1", "2", "3"];

    expect(() => repository.save(broken)).toThrow(
      `Не удалось сохранить задачу в «${filePath}»: несогласованное состояние задачи, результатов больше, чем шагов плана.`,
    );
    expect(readFileSync(filePath, "utf8")).toBe(before);
    expect(readdirSync(join(directory, "nested"))).toEqual([".agent-task.json"]);
  });

  it("does not create a file when saving fails validation for a new task", () => {
    const broken = snapshot();
    broken.context.state = "planning";
    expect(() => new JsonTaskRepository(filePath).save(broken)).toThrow("на этапе planning есть результаты шагов");
    expect(existsSync(filePath)).toBe(false);
  });
});
