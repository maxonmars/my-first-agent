import { z } from "zod";
import { readTextFile, replaceFile } from "./json-file.ts";
import { describeIssue, TASK_STATES, type TaskRepository, type TaskSnapshot, taskSnapshotProblem } from "./task.ts";

const nonBlank = z.string().refine((value) => value.trim().length > 0, { error: "пустая строка" });
const snapshotSchema = z.strictObject({
  context: z.strictObject({
    task: nonBlank,
    state: z.enum(TASK_STATES),
    paused: z.boolean(),
    plan: z.array(nonBlank),
    results: z.array(nonBlank),
    waitingFor: nonBlank.nullable(),
    review: z.strictObject({ passed: z.boolean(), text: nonBlank }).nullable(),
  }),
  messages: z.array(z.strictObject({ role: z.enum(["user", "assistant"]), content: nonBlank })),
});

/** Состояние и переписка задачи одним файлом; `null` в файле — задачи нет. */
export class JsonTaskRepository implements TaskRepository {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  load(): TaskSnapshot | null {
    const prefix = `Не удалось загрузить задачу из «${this.filePath}»`;
    const source = readTextFile(this.filePath, prefix);
    if (source === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      throw new Error(`${prefix}: некорректный JSON.`);
    }
    return parsed === null ? null : validateSnapshot(parsed, prefix);
  }

  save(snapshot: TaskSnapshot | null): void {
    const prefix = `Не удалось сохранить задачу в «${this.filePath}»`;
    const content = snapshot === null ? null : validateSnapshot(snapshot, prefix);
    replaceFile(this.filePath, JSON.stringify(content, null, 2), prefix);
  }
}

function validateSnapshot(value: unknown, prefix: string): TaskSnapshot {
  const result = snapshotSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`${prefix}: неверная структура задачи, ${describeIssue(result.error.issues[0]!)}.`);
  }
  const problem = taskSnapshotProblem(result.data);
  if (problem !== null) throw new Error(`${prefix}: несогласованное состояние задачи, ${problem}.`);
  return result.data;
}
