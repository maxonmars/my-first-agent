import { describe, expect, it } from "vitest";

import { greeting } from "../src/greeting.ts";

describe("greeting", () => {
  it("returns a greeting for the supplied name", () => {
    expect(greeting("agent")).toBe("Hello, agent!");
  });
});
