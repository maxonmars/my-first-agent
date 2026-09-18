export const PROFILE_FIELDS = ["style", "constraints", "context"] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

export interface AgentProfile {
  style?: string;
  constraints?: string;
  context?: string;
}

export interface ProfilesState {
  activeProfileId: string | null;
  profiles: Record<string, AgentProfile>;
}

export interface ProfilesRepository {
  load(): ProfilesState | null;
  save(state: ProfilesState): void;
}

export class ProfileError extends Error {}

export const PROFILE_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}$/u;
export const PROFILE_ID_RULE =
  "идентификатор профиля: 1–64 символа, буквы, цифры, дефис или подчёркивание; первый символ — буква или цифра";

/** Обрезает крайние пробелы; возвращает null, если идентификатор не подходит под правило. */
export function normalizeProfileId(value: string): string | null {
  const profileId = value.trim();
  return PROFILE_ID_PATTERN.test(profileId) ? profileId : null;
}

export function isProfileEmpty(profile: AgentProfile): boolean {
  return Object.keys(profile).length === 0;
}

export const PROFILE_TITLE =
  "Активный профиль агента (выбран командой /profile; context — роль и предметная область, constraints — рабочие ограничения, style — тон, подробность и оформление):";
export const PROFILE_INSTRUCTION = [
  "Перед диалогом отдельным user-блоком в JSON передан активный профиль агента. Он действует в каждом ответе, пока его не изменят командами /profile.",
  "context задаёт твою роль и предметную область, constraints — рабочие ограничения, style — тон, подробность и оформление ответа.",
  "Текущая реплика, память и прежний диалог дают задачу и факты, но не меняют выбранную роль и ограничения. Реплика может уточнить задачу и оформление в пределах ограничений профиля.",
  "Если просьба противоречит роли или ограничениям профиля, объясни конфликт и предложи сменить профиль командой /profile load или изменить его командой /profile set.",
  "Ответы других ролей в истории — материал общей работы; поведение следующего ответа определяет активный профиль.",
  "Общие рекомендации о стиле, в том числе о краткости, уточняются профилем и текущим запросом в пределах ограничений профиля.",
  "Требования к формату, лимиты длины, схема ответа задачи и допустимые действия сохраняют силу. Смена профиля не утверждает план и не меняет этап задачи.",
].join("\n");
export const PROFILE_META_INSTRUCTION =
  "Включи в составляемый промпт роль, ограничения и стиль активного профиля агента, но сам не отвечай на задачу.";
