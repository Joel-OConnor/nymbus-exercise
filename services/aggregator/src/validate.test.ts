import { describe, expect, it } from "vitest";
import { isValidEvent } from "./validate";

const good = {
  eventId: "4e52f35a-20bf-4d3c-88a4-9c236b31f333",
  occurredAt: "2026-11-03T04:16:45.546Z",
  tenantId: "t001",
  vendor: "atlas",
  sourceConn: "atlas-2",
  msgType: "0200",
  txnFamily: "purchase",
  outcomeCode: "00",
  amount: 57.1,
  latencyMs: 204,
  stan: "223262",
  bin: "596111",
};

describe("isValidEvent", () => {
  it("accepts what the connector emits", () => {
    expect(isValidEvent(good)).toBe(true);
    expect(isValidEvent({ ...good, amount: 0, tenantId: "platform", msgType: "0800", txnFamily: "network" })).toBe(true);
  });

  it("rejects non-objects and nulls", () => {
    expect(isValidEvent(null)).toBe(false);
    expect(isValidEvent(undefined)).toBe(false);
    expect(isValidEvent("{}")).toBe(false);
    expect(isValidEvent(42)).toBe(false);
  });

  it("rejects values that would fail at the database", () => {
    expect(isValidEvent({ ...good, eventId: "not-a-uuid" })).toBe(false); // uuid column
    expect(isValidEvent({ ...good, latencyMs: 12.5 })).toBe(false); // integer column
    expect(isValidEvent({ ...good, latencyMs: "200" })).toBe(false);
    expect(isValidEvent({ ...good, amount: "57.10" })).toBe(false); // .toFixed would throw
    expect(isValidEvent({ ...good, amount: Number.NaN })).toBe(false);
    expect(isValidEvent({ ...good, occurredAt: "yesterday" })).toBe(false);
  });

  it("rejects missing or oversized dimension values", () => {
    const { tenantId: _omit, ...missing } = good;
    expect(isValidEvent(missing)).toBe(false);
    expect(isValidEvent({ ...good, vendor: "" })).toBe(false);
    expect(isValidEvent({ ...good, outcomeCode: "x".repeat(65) })).toBe(false);
    expect(isValidEvent({ ...good, tenantId: "t001; drop table tenant" })).toBe(false);
  });

  it("rejects negative measures", () => {
    expect(isValidEvent({ ...good, amount: -1 })).toBe(false);
    expect(isValidEvent({ ...good, latencyMs: -5 })).toBe(false);
  });
});
