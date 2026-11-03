import { describe, expect, it } from "vitest";
import { MESSAGE_TYPES, OUTCOME_CODES, TXN_FAMILIES, outcomeClass, outcomeLabel } from "./iso8583";

describe("outcome codes", () => {
  it("classifies the codes the dashboard depends on", () => {
    expect(outcomeClass("00")).toBe("approved");
    expect(outcomeClass("51")).toBe("soft_decline");
    expect(outcomeClass("05")).toBe("soft_decline");
    expect(outcomeClass("14")).toBe("hard_decline");
    expect(outcomeClass("41")).toBe("hard_decline");
    expect(outcomeClass("91")).toBe("system_error");
    expect(outcomeClass("96")).toBe("system_error");
    expect(outcomeClass("30")).toBe("format_error");
  });

  it("treats an unknown code as a system error so it is never silently 'fine'", () => {
    expect(outcomeClass("ZZ")).toBe("system_error");
    expect(outcomeLabel("ZZ")).toBe("Code ZZ");
  });

  it("gives every known code exactly one of the five classes", () => {
    const classes = new Set(["approved", "soft_decline", "hard_decline", "system_error", "format_error"]);
    for (const [code, v] of Object.entries(OUTCOME_CODES)) {
      expect(code).toMatch(/^\d{2}$/);
      expect(classes.has(v.class)).toBe(true);
      expect(v.label.length).toBeGreaterThan(0);
    }
    // Only one code is "approved"; that assumption is baked into the SQL measures.
    expect(Object.values(OUTCOME_CODES).filter((v) => v.class === "approved")).toHaveLength(1);
  });
});

describe("message types and families", () => {
  it("marks network management as the only non-financial MTI", () => {
    const nonFinancial = Object.entries(MESSAGE_TYPES).filter(([, v]) => !v.financial).map(([k]) => k);
    expect(nonFinancial).toEqual(["0800"]);
  });

  it("has a 'network' family for 0800s and unique processing codes", () => {
    expect(TXN_FAMILIES.network).toBeDefined();
    const codes = Object.values(TXN_FAMILIES).map((f) => f.processingCode);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
