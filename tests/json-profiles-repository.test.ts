import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceFile } from "../src/json-file.ts";
import { JsonProfilesRepository } from "../src/json-profiles-repository.ts";
import type { ProfilesState } from "../src/profile.ts";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync), renameSync: vi.fn(fs.renameSync) };
});

const { renameSync } = await import("node:fs");
const SECRET = "секрет профиля";

const state: ProfilesState = {
  activeUserId: "Макс",
  profiles: {
    Макс: { style: "На ты, кратко", constraints: "Без эмодзи", context: "Backend-разработчик" },
    Владимир: { style: "На вы, подробно" },
    макс: {},
    constructor: { context: "обычный идентификатор" },
  },
};

function errorOf(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    return error as Error;
  }
  throw new Error("Ожидалась ошибка.");
}

describe("JSON profiles repository", () => {
  let directory: string;
  let filePath: string;
  let repository: JsonProfilesRepository;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "agent-profiles-repository-"));
    filePath = join(directory, ".agent-profiles.json");
    repository = new JsonProfilesRepository(filePath);
  });

  afterEach(() => {
    vi.resetAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it("returns null for a missing file without creating it", () => {
    expect(repository.load()).toBeNull();
    expect(readdirSync(directory)).toEqual([]);
  });

  it("saves indented JSON atomically and reloads case-sensitive identifiers, empty profiles and constructor", () => {
    repository.save(state);

    expect(readFileSync(filePath, "utf8")).toBe(JSON.stringify(state, null, 2));
    const loaded = new JsonProfilesRepository(filePath).load()!;
    expect(loaded).toEqual(state);
    expect(Object.keys(loaded.profiles)).toEqual(["Макс", "Владимир", "макс", "constructor"]);
    expect(readdirSync(directory)).toEqual([".agent-profiles.json"]);
    expect(vi.mocked(renameSync).mock.calls[0]![1]).toBe(filePath);
  });

  it("loads without rewriting the file", () => {
    const source = JSON.stringify({ activeUserId: null, profiles: { Макс: { style: " с пробелами " } } });
    writeFileSync(filePath, source);

    expect(repository.load()).toEqual({ activeUserId: null, profiles: { Макс: { style: " с пробелами " } } });
    expect(readFileSync(filePath, "utf8")).toBe(source);
    expect(renameSync).not.toHaveBeenCalled();
  });

  it.each([
    ["[]", "ожидается JSON-объект каталога, получено array"],
    [`{"activeUserId":null}`, "profiles должен быть JSON-объектом, получено undefined"],
    [`{"activeUserId":null,"profiles":{},"extra":"${SECRET}"}`, "неизвестное поле каталога"],
    [`{"activeUserId":42,"profiles":{}}`, "activeUserId должен быть строкой или null, получено number"],
    [`{"activeUserId":"Макс","profiles":{}}`, "activeUserId не найден среди профилей"],
    [`{"activeUserId":"toString","profiles":{}}`, "activeUserId не найден среди профилей"],
    [`{"activeUserId":"a b","profiles":{"a b":{}}}`, "недопустимый activeUserId"],
    [`{"activeUserId":null,"profiles":{"_${SECRET}":{}}}`, "недопустимый идентификатор пользователя"],
    [`{"activeUserId":null,"profiles":{"__proto__":{"style":"${SECRET}"}}}`, "недопустимый идентификатор пользователя"],
    [`{"activeUserId":null,"profiles":{"${"k".repeat(65)}":{}}}`, "недопустимый идентификатор пользователя"],
    [`{"activeUserId":null,"profiles":{"Макс":"${SECRET}"}}`, "профиль должен быть JSON-объектом, получено string"],
    [`{"activeUserId":null,"profiles":{"Макс":{"mood":"${SECRET}"}}}`, "неизвестное поле профиля"],
    [`{"activeUserId":null,"profiles":{"Макс":{"__proto__":"${SECRET}"}}}`, "неизвестное поле профиля"],
    [`{"activeUserId":null,"profiles":{"Макс":{"style":42}}}`, "значение профиля должно быть строкой, получено number"],
    [`{"activeUserId":null,"profiles":{"Макс":{"context":" \\n "}}}`, "значение профиля — пустая строка"],
  ])("rejects %s with the path and reason but without profile contents", (source, reason) => {
    writeFileSync(filePath, source);

    const error = errorOf(() => repository.load());

    expect(error.message).toBe(
      `Не удалось загрузить профили из «${filePath}»: неверная структура профилей, ${reason}.`,
    );
    expect(error.message).not.toContain(SECRET);
    expect(readFileSync(filePath, "utf8")).toBe(source);
  });

  it("reports invalid JSON and read errors without the stack or contents", () => {
    writeFileSync(filePath, `{"profiles":"${SECRET}"`);
    expect(errorOf(() => repository.load()).message).toBe(
      `Не удалось загрузить профили из «${filePath}»: некорректный JSON.`,
    );

    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error(SECRET), { code: "EACCES" });
    });
    const error = errorOf(() => repository.load());
    expect(error.message).toBe(`Не удалось загрузить профили из «${filePath}»: ошибка чтения файла (EACCES).`);
  });

  it("validates before saving and keeps the previous file on a write failure", () => {
    repository.save(state);
    const before = readFileSync(filePath, "utf8");

    const invalid = errorOf(() => repository.save({ activeUserId: "Никто", profiles: {} }));
    expect(invalid.message).toBe(
      `Не удалось сохранить профили в «${filePath}»: неверная структура профилей, activeUserId не найден среди профилей.`,
    );
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error(SECRET), { code: "ENOSPC" });
    });
    const failed = errorOf(() => repository.save({ activeUserId: null, profiles: {} }));
    expect(failed.message).toBe(`Не удалось сохранить профили в «${filePath}»: ошибка замены файла (ENOSPC).`);
    expect(readFileSync(filePath, "utf8")).toBe(before);
    expect(readdirSync(directory)).toEqual([".agent-profiles.json"]);
  });
});

describe("atomic file replacement", () => {
  it("creates missing parent directories and reports a directory failure", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-json-file-"));
    try {
      const nested = join(directory, ".agent-users", "hash", "file.json");
      replaceFile(nested, "{}", "prefix");
      expect(readFileSync(nested, "utf8")).toBe("{}");

      writeFileSync(join(directory, "plain"), "");
      expect(() => replaceFile(join(directory, "plain", "file.json"), "{}", "prefix")).toThrow(
        /^prefix: ошибка создания каталога \((ENOTDIR|EEXIST)\)\.$/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
