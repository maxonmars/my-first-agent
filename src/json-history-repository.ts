import { z } from "zod";
import { factsSchema } from "./facts.ts";
import type { HistoryRepository, HistoryState } from "./history.ts";
import { readTextFile, replaceFile } from "./json-file.ts";

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

export class JsonHistoryRepository implements HistoryRepository {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  load(): HistoryState | null {
    const source = readTextFile(this.filePath, `Не удалось загрузить историю из «${this.filePath}»`);
    if (source === null) return null;

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
    replaceFile(
      this.filePath,
      JSON.stringify(
        validated.kind === "compression" ? { summary: validated.summary, messages: validated.messages } : validated,
        null,
        2,
      ),
      `Не удалось сохранить историю в «${this.filePath}»`,
    );
  }
}
