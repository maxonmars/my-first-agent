import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonMemoryRepository } from "../src/json-memory-repository.ts";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: vi.fn(fs.readFileSync),
    writeFileSync: vi.fn(fs.writeFileSync),
    renameSync: vi.fn(fs.renameSync),
    unlinkSync: vi.fn(fs.unlinkSync),
  };
});

const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const SECRET = "секрет памяти";

function fileError(code: string): Error {
  return Object.assign(new Error(SECRET), { code });
}

function errorOf(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    return error as Error;
  }
  throw new Error("Ожидалась ошибка.");
}

describe("JSON memory repository", () => {
  let directory: string;
  let filePath: string;
  let repository: JsonMemoryRepository;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "agent-memory-repository-"));
    filePath = join(directory, ".agent-memory.working.json");
    repository = new JsonMemoryRepository(filePath, "working");
  });

  afterEach(() => {
    vi.resetAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it("returns null for a missing file without creating it", () => {
    expect(repository.load()).toBeNull();
    expect(readdirSync(directory)).toEqual([]);
  });

  it("saves indented UTF-8 JSON atomically and reloads literal case-sensitive keys", () => {
    const entries = {
      goal: "  поездка в  Казань 🚆 ",
      Goal: "другая запись",
      "2026-budget": "30000 рублей",
      constructor: "обычный ключ",
      ["k".repeat(64)]: "длинный ключ",
    };

    repository.save(entries);

    expect(readFileSync(filePath, "utf8")).toBe(JSON.stringify(entries, null, 2));
    expect(new JsonMemoryRepository(filePath, "working").load()).toEqual(entries);
    expect(readdirSync(directory)).toEqual([".agent-memory.working.json"]);
    const [temporaryPath, destination] = vi.mocked(renameSync).mock.calls[0]!;
    expect(temporaryPath).toMatch(new RegExp(`^${filePath.replaceAll(".", "\\.")}\\.[0-9a-f-]{36}\\.tmp$`));
    expect(destination).toBe(filePath);
    expect(vi.mocked(writeFileSync).mock.calls[0]![0]).toBe(temporaryPath);
  });

  it("persists an empty dictionary without deleting the file", () => {
    repository.save({ goal: "поездка в Казань" });
    repository.save({});

    expect(readFileSync(filePath, "utf8")).toBe("{}");
    expect(repository.load()).toEqual({});
    expect(readdirSync(directory)).toEqual([".agent-memory.working.json"]);
  });

  it("rejects malformed JSON without exposing content or changing the file", () => {
    const source = `{"goal":"${SECRET}"`;
    writeFileSync(filePath, source, "utf8");

    expect(errorOf(() => repository.load()).message).toBe(
      `Не удалось загрузить память working из «${filePath}»: некорректный JSON.`,
    );
    expect(readFileSync(filePath, "utf8")).toBe(source);
  });

  it.each([
    ["array root", JSON.stringify([SECRET]), "ожидается JSON-объект со строковыми значениями, получено array"],
    ["null root", "null", "ожидается JSON-объект со строковыми значениями, получено null"],
    ["string root", JSON.stringify(SECRET), "ожидается JSON-объект со строковыми значениями, получено string"],
    ["number value", '{"budget":30000}', "значение записи должно быть строкой, получено number"],
    ["boolean value", '{"train":true}', "значение записи должно быть строкой, получено boolean"],
    ["null value", '{"goal":null}', "значение записи должно быть строкой, получено null"],
    ["array value", `{"goals":["${SECRET}"]}`, "значение записи должно быть строкой, получено array"],
    ["nested object", `{"trip":{"city":"${SECRET}"}}`, "значение записи должно быть строкой, получено object"],
    ["empty value", '{"goal":" \\n "}', "значение записи — пустая строка"],
    ["empty key", `{"":"${SECRET}"}`, "недопустимый ключ записи"],
    ["path-like key", `{"trip.city":"${SECRET}"}`, "недопустимый ключ записи"],
    ["key starting with underscore", `{"_goal":"${SECRET}"}`, "недопустимый ключ записи"],
    ["prototype key", `{"__proto__":"${SECRET}"}`, "недопустимый ключ записи"],
    ["too long key", `{"${"k".repeat(65)}":"${SECRET}"}`, "недопустимый ключ записи"],
  ])("rejects %s on load with the reason, without content and without changing the file", (_name, source, reason) => {
    writeFileSync(filePath, source, "utf8");

    const error = errorOf(() => repository.load());

    expect(error.message).toBe(
      `Не удалось загрузить память working из «${filePath}»: неверная структура памяти, ${reason}.`,
    );
    expect(error.message).not.toContain(SECRET);
    expect(readFileSync(filePath, "utf8")).toBe(source);
  });

  it("validates entries before saving and keeps the previous file", () => {
    repository.save({ goal: "поездка в Казань" });
    const source = readFileSync(filePath, "utf8");

    expect(errorOf(() => repository.save({ goal: "   " })).message).toBe(
      `Не удалось сохранить память working в «${filePath}»: неверная структура памяти, значение записи — пустая строка.`,
    );
    expect(errorOf(() => repository.save({ [`bad ${SECRET}`]: "значение" })).message).not.toContain(SECRET);
    expect(writeFileSync).toHaveBeenCalledOnce();
    expect(readFileSync(filePath, "utf8")).toBe(source);
  });

  it("names the long-term layer and does not treat other read errors as a missing file", () => {
    const longPath = join(directory, ".agent-memory.long-term.json");
    writeFileSync(longPath, '{"transport":"предпочитаю поезд"}', "utf8");
    const longRepository = new JsonMemoryRepository(longPath, "long");
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw fileError("EACCES");
    });

    expect(errorOf(() => longRepository.load()).message).toBe(
      `Не удалось загрузить память long из «${longPath}»: ошибка чтения файла (EACCES).`,
    );
    expect(longRepository.load()).toEqual({ transport: "предпочитаю поезд" });

    const invalidPath = join(longPath, "memory.json");
    expect(errorOf(() => new JsonMemoryRepository(invalidPath, "long").load()).message).toBe(
      `Не удалось загрузить память long из «${invalidPath}»: ошибка чтения файла (ENOTDIR).`,
    );
  });

  it("keeps the old file and removes the partial temporary file when writing fails", () => {
    repository.save({ goal: "поездка в Казань" });
    const source = readFileSync(filePath, "utf8");
    vi.mocked(writeFileSync).mockImplementationOnce((path) => {
      realFs.writeFileSync(path, "partial write", "utf8");
      throw fileError("ENOSPC");
    });

    const error = errorOf(() => repository.save({ goal: SECRET }));

    expect(error.message).toBe(
      `Не удалось сохранить память working в «${filePath}»: ошибка записи временного файла (ENOSPC).`,
    );
    expect(readFileSync(filePath, "utf8")).toBe(source);
    expect(readdirSync(directory)).toEqual([".agent-memory.working.json"]);
  });

  it("keeps the old file and cleans up the temporary file when replacement fails", () => {
    repository.save({ goal: "поездка в Казань" });
    const source = readFileSync(filePath, "utf8");
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw fileError("EACCES");
    });

    const error = errorOf(() => repository.save({ goal: SECRET }));

    expect(error.message).toBe(`Не удалось сохранить память working в «${filePath}»: ошибка замены файла (EACCES).`);
    expect(readFileSync(filePath, "utf8")).toBe(source);
    expect(readdirSync(directory)).toEqual([".agent-memory.working.json"]);
    expect(unlinkSync).toHaveBeenCalledOnce();

    repository.save({ goal: "новая цель" });
    expect(repository.load()).toEqual({ goal: "новая цель" });
  });
});
