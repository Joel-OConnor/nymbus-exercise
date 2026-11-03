import { describe, expect, it } from "vitest";
import { intParam } from "./params";

describe("intParam", () => {
  it("uses the default when the parameter is absent or empty", () => {
    expect(intParam(undefined, 100, 1, 500)).toBe(100);
    expect(intParam("", 100, 1, 500)).toBe(100);
  });

  it("parses and clamps numeric input", () => {
    expect(intParam("50", 100, 1, 500)).toBe(50);
    expect(intParam("0", 100, 1, 500)).toBe(1);
    expect(intParam("99999", 100, 1, 500)).toBe(500);
    expect(intParam("12.9", 100, 1, 500)).toBe(12);
    expect(intParam("-5", 100, 1, 500)).toBe(1);
  });

  it("falls back to the default on garbage instead of producing NaN", () => {
    expect(intParam("abc", 100, 1, 500)).toBe(100);
    expect(intParam("NaN", 100, 1, 500)).toBe(100);
    expect(intParam("Infinity", 100, 1, 500)).toBe(100);
    expect(intParam("1e999", 100, 1, 500)).toBe(100);
  });
});
