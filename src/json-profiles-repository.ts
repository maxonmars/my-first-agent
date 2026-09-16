import { z } from "zod";
import { jsonType } from "./facts.ts";
import { readTextFile, replaceFile } from "./json-file.ts";
import { type ProfilesRepository, type ProfilesState, USER_ID_PATTERN } from "./profile.ts";

// Сообщения не содержат идентификаторов и значений профилей.
const profileValueSchema = z
  .string({ error: (issue) => `значение профиля должно быть строкой, получено ${jsonType(issue.input)}` })
  .refine((value) => value.trim().length > 0, { error: "значение профиля — пустая строка" });
const profileSchema = z.strictObject(
  {
    style: profileValueSchema.optional(),
    constraints: profileValueSchema.optional(),
    context: profileValueSchema.optional(),
  },
  {
    error: (issue) =>
      issue.code === "unrecognized_keys"
        ? "неизвестное поле профиля"
        : `профиль должен быть JSON-объектом, получено ${jsonType(issue.input)}`,
  },
);
const stateSchema = z.strictObject(
  {
    activeUserId: z
      .string({ error: (issue) => `activeUserId должен быть строкой или null, получено ${jsonType(issue.input)}` })
      .regex(USER_ID_PATTERN, { error: "недопустимый activeUserId" })
      .nullable(),
    profiles: z.record(z.string().regex(USER_ID_PATTERN), profileSchema, {
      error: (issue) =>
        issue.code === "invalid_key"
          ? "недопустимый идентификатор пользователя"
          : `profiles должен быть JSON-объектом, получено ${jsonType(issue.input)}`,
    }),
  },
  {
    error: (issue) =>
      issue.code === "unrecognized_keys"
        ? "неизвестное поле каталога"
        : `ожидается JSON-объект каталога, получено ${jsonType(issue.input)}`,
  },
);

export class JsonProfilesRepository implements ProfilesRepository {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  load(): ProfilesState | null {
    const prefix = `Не удалось загрузить профили из «${this.filePath}»`;
    const source = readTextFile(this.filePath, prefix);
    if (source === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      throw new Error(`${prefix}: некорректный JSON.`);
    }
    return validateState(parsed, prefix);
  }

  save(state: ProfilesState): void {
    const prefix = `Не удалось сохранить профили в «${this.filePath}»`;
    replaceFile(this.filePath, JSON.stringify(validateState(state, prefix), null, 2), prefix);
  }
}

function validateState(value: unknown, prefix: string): ProfilesState {
  // Zod record молча отбрасывает собственный ключ __proto__ вместо ошибки invalid_key.
  const profiles = typeof value === "object" && value !== null && "profiles" in value ? value.profiles : undefined;
  if (typeof profiles === "object" && profiles !== null && Object.hasOwn(profiles, "__proto__")) {
    throw new Error(`${prefix}: неверная структура профилей, недопустимый идентификатор пользователя.`);
  }
  const result = stateSchema.safeParse(value);
  if (!result.success) throw new Error(`${prefix}: неверная структура профилей, ${result.error.issues[0]!.message}.`);
  const state = result.data;
  if (state.activeUserId !== null && !Object.hasOwn(state.profiles, state.activeUserId)) {
    throw new Error(`${prefix}: неверная структура профилей, activeUserId не найден среди профилей.`);
  }
  return state;
}
