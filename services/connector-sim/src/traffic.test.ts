import { describe, expect, it } from "vitest";
import { MESSAGE_TYPES, OUTCOME_CODES, PLATFORM_TENANT_ID, TXN_FAMILIES } from "@nymbus/shared";
import type { Effects } from "./scenarios";
import type { SimTenant } from "./tenants";
import { generateNetworkMessage, generateTransaction } from "./traffic";

const tenant: SimTenant = { tenantId: "t001", name: "First Bank", vendor: "atlas", baseTps: 15, bins: ["400001", "510001"] };
const NEUTRAL: Effects = { latencyMultiplier: 1, declineBoost: 0, errorBoost: 0, tpsMultiplier: 1, outage: false };
const now = new Date("2026-11-03T12:00:00Z");

describe("generateTransaction", () => {
  it("produces a complete, well-formed metric event", () => {
    for (let i = 0; i < 200; i++) {
      const e = generateTransaction(tenant, NEUTRAL, now);
      expect(e.eventId).toMatch(/^[0-9a-f-]{36}$/);
      expect(e.occurredAt).toBe(now.toISOString());
      expect(e.tenantId).toBe("t001");
      expect(e.vendor).toBe("atlas");
      expect(e.sourceConn).toMatch(/^atlas-[123]$/);
      expect(Object.keys(MESSAGE_TYPES)).toContain(e.msgType);
      expect(e.msgType).not.toBe("0800");
      expect(Object.keys(TXN_FAMILIES)).toContain(e.txnFamily);
      expect(e.txnFamily).not.toBe("network");
      expect(Object.keys(OUTCOME_CODES)).toContain(e.outcomeCode);
      expect(e.amount).toBeGreaterThan(0);
      expect(Number.isInteger(e.latencyMs)).toBe(true);
      expect(e.latencyMs).toBeGreaterThan(0);
      expect(e.stan).toMatch(/^\d{6}$/);
      expect(tenant.bins).toContain(e.bin);
    }
  });

  it("approves most traffic at steady state", () => {
    let approved = 0;
    const n = 5000;
    for (let i = 0; i < n; i++) if (generateTransaction(tenant, NEUTRAL, now).outcomeCode === "00") approved++;
    expect(approved / n).toBeGreaterThan(0.88);
    expect(approved / n).toBeLessThan(0.97);
  });

  it("turns a severe latency spike into issuer timeouts (91), capped at the timeout", () => {
    const e = generateTransaction(tenant, { ...NEUTRAL, latencyMultiplier: 1000 }, now);
    expect(e.outcomeCode).toBe("91");
    expect(e.latencyMs).toBeGreaterThanOrEqual(2500);
    expect(e.latencyMs).toBeLessThanOrEqual(2550);
  });

  it("forces financial requests into soft declines under a decline spike", () => {
    const soft = new Set(["51", "05", "61"]);
    for (let i = 0; i < 300; i++) {
      const e = generateTransaction(tenant, { ...NEUTRAL, declineBoost: 1 }, now);
      if (e.msgType === "0100" || e.msgType === "0200") expect(soft.has(e.outcomeCode) || e.outcomeCode === "91").toBe(true);
    }
  });

  it("forces financial requests into system errors under an error scenario", () => {
    for (let i = 0; i < 300; i++) {
      const e = generateTransaction(tenant, { ...NEUTRAL, errorBoost: 1 }, now);
      if (e.msgType === "0100" || e.msgType === "0200") expect(["91", "96"]).toContain(e.outcomeCode);
    }
  });

  it("rounds withdrawals to the nearest $20 like an ATM", () => {
    const amounts = Array.from({ length: 2000 }, () => generateTransaction(tenant, NEUTRAL, now))
      .filter((e) => e.txnFamily === "withdrawal")
      .map((e) => e.amount);
    expect(amounts.length).toBeGreaterThan(50);
    for (const a of amounts) expect(a % 20).toBe(0);
  });
});

describe("generateNetworkMessage", () => {
  it("attributes heartbeats to the reserved platform tenant", () => {
    const e = generateNetworkMessage("summit", now);
    expect(e.tenantId).toBe(PLATFORM_TENANT_ID);
    expect(e.msgType).toBe("0800");
    expect(e.txnFamily).toBe("network");
    expect(e.outcomeCode).toBe("00");
    expect(e.amount).toBe(0);
    expect(e.vendor).toBe("summit");
  });
});
