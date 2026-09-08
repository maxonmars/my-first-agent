import * as YAML from "yaml";

export const FORMAT_NAMES = ["text", "json", "markdown", "yaml"] as const;

export type FormatName = (typeof FORMAT_NAMES)[number];

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

interface FormatSpec {
  instruction: string;
  validate(answer: string): ValidationResult;
}

export const FORMATS: Record<FormatName, FormatSpec> = {
  text: {
    instruction: "",
    validate: () => ({ ok: true }),
  },
  json: {
    instruction: "Верни только валидный JSON-объект без markdown-обёртки и пояснений.",
    validate: validateJson,
  },
  markdown: {
    instruction: "Оформи ответ в Markdown и используй хотя бы один заголовок.",
    validate: (answer: string) =>
      /^#{1,6}\s+\S/m.test(answer) ? { ok: true } : { ok: false, reason: "нет заголовка Markdown" },
  },
  yaml: {
    instruction: "Верни только валидный YAML-объект или массив без markdown-обёртки и пояснений.",
    validate: validateYaml,
  },
};

function isStructured(value: unknown): boolean {
  return value !== null && typeof value === "object";
}

function validateJson(answer: string): ValidationResult {
  try {
    const parsed: unknown = JSON.parse(answer);

    return isStructured(parsed) && !Array.isArray(parsed)
      ? { ok: true }
      : { ok: false, reason: "на верхнем уровне ожидался объект" };
  } catch {
    return { ok: false, reason: "не разбирается как JSON" };
  }
}

function validateYaml(answer: string): ValidationResult {
  try {
    return isStructured(YAML.parse(answer))
      ? { ok: true }
      : { ok: false, reason: "на верхнем уровне ожидался объект или массив" };
  } catch {
    return { ok: false, reason: "не разбирается как YAML" };
  }
}
