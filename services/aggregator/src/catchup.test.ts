import { describe, expect, it } from "vitest";
import { PARTITION_SPECS } from "@nymbus/db";
import type { TxnMetricEvent } from "@nymbus/shared";
import type { RollupAcc } from "./accumulator";
import { planFlush } from "./catchup";

const now = new Date("2026-11-03T12:34:56Z");
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

function rollup(bucketTs: Date): RollupAcc {
  return { bucketTs, tenantId: "t001", vendor: "atlas", msgType: "0200", txnFamily: "purchase", outcomeCode: "00", count: 1, amountSum: 1, latencySum: 100, latencyMax: 100, bins: new Array(10).fill(0) };
}
function event(occurredAt: Date): TxnMetricEvent {
  return { eventId: "e", occurredAt: occurredAt.toISOString(), tenantId: "t001", vendor: "atlas", sourceConn: "atlas-1", msgType: "0200", txnFamily: "purchase", outcomeCode: "00", amount: 1, latencyMs: 100, stan: "1", bin: "400000" };
}

describe("planFlush", () => {
  it("does nothing special in steady state", () => {
    const p = planFlush({ rollup1m: [rollup(ago(1))], rollup5m: [rollup(ago(5))], events: [event(ago(0.5)), event(ago(3))] }, now);
    expect(p.ensure).toEqual([]);
    expect(p.expiredRollups).toBe(0);
    expect(p.expiredEvents).toBe(0);
    expect(p.rollup1m).toHaveLength(1);
    expect(p.events).toHaveLength(2);
  });

  it("asks for partitions when catching up on data older than the ready window", () => {
    // Rollups: ready window is 11:00..15:00. A 4-hour-old bucket needs its hour created.
    const p = planFlush({ rollup1m: [rollup(ago(240)), rollup(ago(1))], rollup5m: [], events: [] }, now);
    expect(p.ensure).toHaveLength(1);
    expect(p.ensure[0].spec.table).toBe("txn_rollup_1m");
    expect(p.ensure[0].from.toISOString()).toBe(ago(240).toISOString());
    expect(p.ensure[0].to.toISOString()).toBe(ago(1).toISOString());
    expect(p.rollup1m).toHaveLength(2);
  });

  it("also asks for partitions for data ahead of the ready window (clock skew)", () => {
    const p = planFlush({ rollup1m: [rollup(new Date("2026-11-03T15:00:00Z"))], rollup5m: [], events: [] }, now);
    expect(p.ensure.map((e) => e.spec.table)).toEqual(["txn_rollup_1m"]);
  });

  it("skips raw events past the 75-minute retention but keeps their rollups", () => {
    const p = planFlush({ rollup1m: [rollup(ago(90))], rollup5m: [rollup(ago(90))], events: [event(ago(90)), event(ago(80)), event(ago(70)), event(ago(1))] }, now);
    expect(p.expiredEvents).toBe(2);
    expect(p.events.map((e) => e.occurredAt)).toEqual([ago(70).toISOString(), ago(1).toISOString()]);
    expect(p.expiredRollups).toBe(0);
    expect(p.rollup1m).toHaveLength(1);
    // The surviving 70-minute-old event is outside the ready raw window (12:15..13:15), so its slice is created.
    const ev = p.ensure.find((e) => e.spec.table === "txn_event")!;
    expect(ev.from.toISOString()).toBe(ago(70).toISOString());
  });

  it("drops rollup rows older than rollup retention", () => {
    const p = planFlush({ rollup1m: [rollup(ago(26 * 60)), rollup(ago(1))], rollup5m: [rollup(ago(26 * 60))], events: [] }, now);
    expect(p.expiredRollups).toBe(2);
    expect(p.rollup1m).toHaveLength(1);
    expect(p.rollup5m).toHaveLength(0);
    expect(p.ensure).toEqual([]);
  });

  it("uses the real partition specs by default", () => {
    expect(() => planFlush({ rollup1m: [], rollup5m: [], events: [] }, now, PARTITION_SPECS)).not.toThrow();
    expect(() => planFlush({ rollup1m: [], rollup5m: [], events: [] }, now, [])).toThrow(/no partition spec/);
  });
});
