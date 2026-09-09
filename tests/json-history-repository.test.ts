import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryMessage } from "../src/history.ts";
import { JsonHistoryRepository } from "../src/json-history-repository.ts";

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
const originalHistory: HistoryMessage[] = [
  { role: "user", content: "Меня зовут Максим." },
  { role: "assistant", content: "  Приятно познакомиться, Максим.\n\nこんにちは 👋\n  " },
];
const nextHistory: HistoryMessage[] = [
  ...originalHistory,
  { role: "user", content: "Как меня зовут?" },
  { role: "assistant", content: "Максим." },
];

function fileError(code: string): Error {
  return Object.assign(new Error("private dialogue must not appear in the error"), { code });
}

describe("JSON history repository", () => {
  let directory: string;
  let filePath: string;
  let repository: JsonHistoryRepository;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "agent-history-repository-"));
    filePath = join(directory, ".agent-history.json");
    repository = new JsonHistoryRepository(filePath);
  });

  afterEach(() => {
    vi.resetAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it("returns an empty history when the file does not exist", () => {
    expect(repository.load()).toEqual([]);
    expect(readdirSync(directory)).toEqual([]);
  });

  it("saves UTF-8 JSON with indentation and reloads Unicode and whitespace unchanged", () => {
    repository.save(originalHistory);

    expect(readFileSync(filePath, "utf8")).toBe(JSON.stringify(originalHistory, null, 2));
    expect(new JsonHistoryRepository(filePath).load()).toEqual(originalHistory);
    expect(readdirSync(directory)).toEqual([".agent-history.json"]);
    const [temporaryPath, destination] = vi.mocked(renameSync).mock.calls[0];
    expect(temporaryPath).toMatch(new RegExp(`^${filePath.replaceAll(".", "\\.")}\\.[0-9a-f-]{36}\\.tmp$`));
    expect(destination).toBe(filePath);
    expect(vi.mocked(writeFileSync).mock.calls[0][0]).toBe(temporaryPath);
  });

  it("replaces previous history and persists an empty array without deleting the file", () => {
    repository.save(originalHistory);
    repository.save(nextHistory);
    expect(repository.load()).toEqual(nextHistory);

    repository.save([]);
    expect(readFileSync(filePath, "utf8")).toBe("[]");
    expect(repository.load()).toEqual([]);
    expect(readdirSync(directory)).toEqual([".agent-history.json"]);
  });

  it("rejects malformed JSON without exposing content or changing the file", () => {
    const source = '[{"role":"user","content":"секрет диалога"}';
    writeFileSync(filePath, source, "utf8");

    expect(() => repository.load()).toThrow(`Не удалось загрузить историю из «${filePath}»: некорректный JSON.`);
    expect(readFileSync(filePath, "utf8")).toBe(source);
  });

  it.each([
    ["null root", null],
    ["object root", { messages: [] }],
    ["string root", "секрет диалога"],
    ["null message", [null]],
    ["service role", [{ role: "system", content: "секрет диалога" }]],
    ["missing role", [{ content: "секрет диалога" }]],
    ["missing content", [{ role: "user" }]],
    ["non-string content", [{ role: "user", content: 42 }]],
    ["empty content", [{ role: "user", content: "" }]],
    ["whitespace-only content", [{ role: "user", content: " \t\n " }]],
    ["extra field", [{ role: "user", content: "секрет диалога", apiKey: "private" }]],
  ])("rejects %s without changing the file", (_name, value) => {
    const source = JSON.stringify(value);
    writeFileSync(filePath, source, "utf8");

    expect(() => repository.load()).toThrow(
      `Не удалось загрузить историю из «${filePath}»: неверная структура сообщений.`,
    );
    expect(readFileSync(filePath, "utf8")).toBe(source);
  });

  it.each([
    ["an incomplete first pair", [originalHistory[0]]],
    ["an incomplete later pair", [...originalHistory, nextHistory[2]]],
    ["a reversed pair", [originalHistory[1], originalHistory[0]]],
    ["two user messages", [originalHistory[0], originalHistory[0]]],
    ["an invalid later pair", [...originalHistory, originalHistory[1], originalHistory[0]]],
  ])("rejects %s without changing the file", (_name, messages) => {
    const source = JSON.stringify(messages);
    writeFileSync(filePath, source, "utf8");

    expect(() => repository.load()).toThrow(
      `Не удалось загрузить историю из «${filePath}»: нарушен порядок пар user/assistant.`,
    );
    expect(readFileSync(filePath, "utf8")).toBe(source);
  });

  it("does not treat ENOTDIR as a missing file", () => {
    writeFileSync(filePath, "[]", "utf8");
    const invalidPath = join(filePath, "history.json");

    expect(() => new JsonHistoryRepository(invalidPath).load()).toThrow(
      `Не удалось загрузить историю из «${invalidPath}»: ошибка чтения файла (ENOTDIR).`,
    );
    expect(readFileSync(filePath, "utf8")).toBe("[]");
  });

  it("reports EACCES without exposing the original error or changing the history", () => {
    repository.save(originalHistory);
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw fileError("EACCES");
    });

    expect(() => repository.load()).toThrow(
      `Не удалось загрузить историю из «${filePath}»: ошибка чтения файла (EACCES).`,
    );
    expect(repository.load()).toEqual(originalHistory);
  });

  it.each([
    ["an Error without a code", new Error("секрет диалога")],
    ["a numeric code", { code: 42 }],
    ["null", null],
    ["a string", "секрет диалога"],
  ])("reports a read failure for %s without exposing its contents", (_name, error) => {
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw error;
    });

    expect(() => repository.load()).toThrow(`Не удалось загрузить историю из «${filePath}»: ошибка чтения файла.`);
  });

  it("keeps the old file and removes the partial temporary file when writing fails", () => {
    repository.save(originalHistory);
    const previousSource = readFileSync(filePath, "utf8");
    vi.mocked(writeFileSync).mockImplementationOnce((path) => {
      realFs.writeFileSync(path, "partial write", "utf8");
      throw fileError("ENOSPC");
    });

    expect(() => repository.save(nextHistory)).toThrow(
      `Не удалось сохранить историю в «${filePath}»: ошибка записи временного файла (ENOSPC).`,
    );
    expect(readFileSync(filePath, "utf8")).toBe(previousSource);
    expect(repository.load()).toEqual(originalHistory);
    expect(readdirSync(directory)).toEqual([".agent-history.json"]);
  });

  it("keeps the old file and cleans up the temporary file when replacement fails", () => {
    repository.save(originalHistory);
    const previousSource = readFileSync(filePath, "utf8");
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw fileError("EACCES");
    });

    expect(() => repository.save(nextHistory)).toThrow(
      `Не удалось сохранить историю в «${filePath}»: ошибка замены файла (EACCES).`,
    );
    expect(readFileSync(filePath, "utf8")).toBe(previousSource);
    expect(repository.load()).toEqual(originalHistory);
    expect(readdirSync(directory)).toEqual([".agent-history.json"]);

    repository.save(nextHistory);
    expect(repository.load()).toEqual(nextHistory);
  });

  it("preserves the replacement error when temporary file cleanup also fails", () => {
    repository.save(originalHistory);
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw fileError("EACCES");
    });
    vi.mocked(unlinkSync).mockImplementationOnce(() => {
      throw fileError("EPERM");
    });

    expect(() => repository.save(nextHistory)).toThrow(
      `Не удалось сохранить историю в «${filePath}»: ошибка замены файла (EACCES).`,
    );
    expect(repository.load()).toEqual(originalHistory);
    expect(readdirSync(directory)).toHaveLength(2);
  });

  it("reports the original write error when no temporary file was created", () => {
    repository.save(originalHistory);
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error("секрет диалога");
    });

    expect(() => repository.save(nextHistory)).toThrow(
      `Не удалось сохранить историю в «${filePath}»: ошибка записи временного файла.`,
    );
    expect(repository.load()).toEqual(originalHistory);
    expect(readdirSync(directory)).toEqual([".agent-history.json"]);
  });
});
