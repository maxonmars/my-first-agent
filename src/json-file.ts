import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function failureReason(operation: string, error: unknown): string {
  const code = errorCode(error);
  return code ? `${operation} (${code})` : operation;
}

/** Возвращает null только при ENOENT; сообщение исходной ошибки в текст не попадает. */
export function readTextFile(filePath: string, errorPrefix: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw new Error(`${errorPrefix}: ${failureReason("ошибка чтения файла", error)}.`);
  }
}

/** Пишет временный файл рядом с целевым и атомарно заменяет целевой через renameSync. */
export function replaceFile(filePath: string, content: string, errorPrefix: string): void {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  let operation = "ошибка записи временного файла";
  try {
    writeFileSync(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    operation = "ошибка замены файла";
    renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Очистка временного файла выполняется по возможности.
    }
    throw new Error(`${errorPrefix}: ${failureReason(operation, error)}.`);
  }
}
