import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { z } from "zod";
import type { HistoryMessage, HistoryRepository } from "./history.ts";

const historySchema = z.array(
  z.strictObject({
    role: z.enum(["user", "assistant"]),
    content: z.string().refine((content) => content.trim().length > 0),
  }),
);

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function failureReason(operation: string, error: unknown): string {
  const code = errorCode(error);
  return code ? `${operation} (${code})` : operation;
}

export class JsonHistoryRepository implements HistoryRepository {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  load(): HistoryMessage[] {
    let source: string;
    try {
      source = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw new Error(
        `Не удалось загрузить историю из «${this.filePath}»: ${failureReason("ошибка чтения файла", error)}.`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      throw new Error(`Не удалось загрузить историю из «${this.filePath}»: некорректный JSON.`);
    }

    const result = historySchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`Не удалось загрузить историю из «${this.filePath}»: неверная структура сообщений.`);
    }

    const messages = result.data;
    if (
      messages.length % 2 !== 0 ||
      messages.some((message, index) => message.role !== (index % 2 === 0 ? "user" : "assistant"))
    ) {
      throw new Error(`Не удалось загрузить историю из «${this.filePath}»: нарушен порядок пар user/assistant.`);
    }

    return messages;
  }

  save(messages: readonly HistoryMessage[]): void {
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    let operation = "ошибка записи временного файла";
    try {
      writeFileSync(temporaryPath, JSON.stringify(messages, null, 2), { encoding: "utf8", flag: "wx" });
      operation = "ошибка замены файла";
      renameSync(temporaryPath, this.filePath);
    } catch (error) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Очистка временного файла выполняется по возможности.
      }
      throw new Error(`Не удалось сохранить историю в «${this.filePath}»: ${failureReason(operation, error)}.`);
    }
  }
}
