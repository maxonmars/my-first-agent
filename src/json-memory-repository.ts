import { z } from "zod";
import { jsonType } from "./facts.ts";
import { readTextFile, replaceFile } from "./json-file.ts";
import { MEMORY_KEY_PATTERN, type MemoryEntries, type MemoryRepository, type WritableMemoryLayer } from "./memory.ts";

// Сообщения не содержат ключей и значений: ошибка загрузки печатается до начала диалога.
const memoryEntriesSchema = z.record(
  z.string().regex(MEMORY_KEY_PATTERN),
  z
    .string({ error: (issue) => `значение записи должно быть строкой, получено ${jsonType(issue.input)}` })
    .refine((value) => value.trim().length > 0, { error: "значение записи — пустая строка" }),
  {
    error: (issue) =>
      issue.code === "invalid_key"
        ? "недопустимый ключ записи"
        : `ожидается JSON-объект со строковыми значениями, получено ${jsonType(issue.input)}`,
  },
);

export class JsonMemoryRepository implements MemoryRepository {
  private readonly filePath: string;
  private readonly layer: WritableMemoryLayer;

  constructor(filePath: string, layer: WritableMemoryLayer) {
    this.filePath = filePath;
    this.layer = layer;
  }

  load(): MemoryEntries | null {
    const prefix = `Не удалось загрузить память ${this.layer} из «${this.filePath}»`;
    const source = readTextFile(this.filePath, prefix);
    if (source === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      throw new Error(`${prefix}: некорректный JSON.`);
    }
    return validateEntries(parsed, prefix);
  }

  save(entries: MemoryEntries): void {
    const prefix = `Не удалось сохранить память ${this.layer} в «${this.filePath}»`;
    replaceFile(this.filePath, JSON.stringify(validateEntries(entries, prefix), null, 2), prefix);
  }
}

function validateEntries(value: unknown, prefix: string): MemoryEntries {
  // Zod record молча отбрасывает собственный ключ __proto__ вместо ошибки invalid_key.
  if (typeof value === "object" && value !== null && Object.hasOwn(value, "__proto__")) {
    throw new Error(`${prefix}: неверная структура памяти, недопустимый ключ записи.`);
  }
  const result = memoryEntriesSchema.safeParse(value);
  if (!result.success) throw new Error(`${prefix}: неверная структура памяти, ${result.error.issues[0]!.message}.`);
  return result.data;
}
