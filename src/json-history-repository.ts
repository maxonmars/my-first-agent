import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { factsSchema } from "./facts.ts";
import type { HistoryRepository, HistoryState } from "./history.ts";

const historySchema = z.array(
  z.strictObject({
    role: z.enum(["user", "assistant"]),
    content: z.string().refine((content) => content.trim().length > 0),
  }),
);

const branchNameSchema = z.string().regex(/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}$/u);
const stateSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("compression"),
    summary: z
      .string()
      .refine((value) => value.trim().length > 0)
      .nullable(),
    messages: historySchema,
  }),
  z.strictObject({ kind: z.literal("sliding"), messages: historySchema }),
  z.strictObject({ kind: z.literal("facts"), messages: historySchema, facts: factsSchema }),
  z.strictObject({
    kind: z.literal("branching"),
    activeBranch: branchNameSchema,
    branches: z.record(branchNameSchema, historySchema),
    checkpoint: historySchema.nullable(),
  }),
]);

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

  load(): HistoryState | null {
    let source: string;
    try {
      source = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
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

    if (Array.isArray(parsed)) parsed = { kind: "compression", summary: null, messages: parsed };
    else if (typeof parsed === "object" && parsed !== null && !("kind" in parsed)) {
      parsed = { ...parsed, kind: "compression" };
    }
    return this.validateState(parsed, "загрузить");
  }

  private validateState(value: unknown, operation: string): HistoryState {
    const prefix = `Не удалось ${operation} историю ${operation === "загрузить" ? "из" : "в"} «${this.filePath}»`;
    const result = stateSchema.safeParse(value);
    if (!result.success) throw new Error(`${prefix}: неверная структура истории.`);
    const state = result.data;
    if (
      state.kind === "branching" &&
      (!Object.hasOwn(state.branches, "main") || !Object.hasOwn(state.branches, state.activeBranch))
    ) {
      throw new Error(`${prefix}: отсутствует main или активная ветка.`);
    }
    const histories =
      state.kind === "branching"
        ? [...Object.values(state.branches), ...(state.checkpoint === null ? [] : [state.checkpoint])]
        : [state.messages];
    if (
      histories.some(
        (messages) =>
          messages.length % 2 !== 0 ||
          messages.some((message, index) => message.role !== (index % 2 === 0 ? "user" : "assistant")),
      )
    ) {
      throw new Error(`${prefix}: нарушен порядок пар user/assistant.`);
    }
    return state;
  }

  save(state: HistoryState): void {
    const validated = this.validateState(state, "сохранить");
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    let operation = "ошибка записи временного файла";
    try {
      writeFileSync(
        temporaryPath,
        JSON.stringify(
          validated.kind === "compression" ? { summary: validated.summary, messages: validated.messages } : validated,
          null,
          2,
        ),
        { encoding: "utf8", flag: "wx" },
      );
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
