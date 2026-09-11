import { describe, expect, it } from "vitest";
import { estimateContextTokens, estimateTextTokens } from "../src/tokens.ts";

describe("token estimates", () => {
  it.each([
    ["", 0],
    ["a", 1],
    ["abcd", 1],
    ["abcde", 2],
    ["привет", 2],
    ["😀😀😀", 2],
  ] as const)("estimates %s by JavaScript string length", (text, expected) => {
    expect(estimateTextTokens(text)).toBe(expected);
  });

  it("sums each content without roles or message overhead", () => {
    expect(estimateContextTokens([])).toBe(0);
    expect(estimateContextTokens([{ content: "a" }, { content: "b" }, { content: "" }])).toBe(2);
  });
});
