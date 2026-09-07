import { describe, expect, it } from "vitest";
import { FORMATS } from "../src/formats.ts";

describe("response format policies", () => {
  it("accepts unrestricted text", () => {
    expect(FORMATS.text.validate("любой текст")).toEqual({ ok: true });
  });

  it("accepts a structured JSON value", () => {
    expect(FORMATS.json.validate('{"answer":42}')).toEqual({ ok: true });
  });

  it("rejects malformed and scalar JSON", () => {
    expect(FORMATS.json.validate("{")).toEqual({ ok: false, reason: "не разбирается как JSON" });
    expect(FORMATS.json.validate('"answer"')).toEqual({
      ok: false,
      reason: "на верхнем уровне ожидался объект",
    });
    expect(FORMATS.json.validate("[1,2,3]")).toEqual({ ok: false, reason: "на верхнем уровне ожидался объект" });
  });

  it("requires a heading in Markdown", () => {
    expect(FORMATS.markdown.validate("## Ответ\n\nТекст")).toEqual({ ok: true });
    expect(FORMATS.markdown.validate("просто текст")).toEqual({ ok: false, reason: "нет заголовка Markdown" });
  });

  it("accepts structured YAML and rejects malformed or scalar YAML", () => {
    expect(FORMATS.yaml.validate("answer: 42")).toEqual({ ok: true });
    expect(FORMATS.yaml.validate("items: [")).toEqual({ ok: false, reason: "не разбирается как YAML" });
    expect(FORMATS.yaml.validate("answer")).toEqual({
      ok: false,
      reason: "на верхнем уровне ожидался объект или массив",
    });
  });
});
