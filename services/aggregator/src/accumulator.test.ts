import { describe, expect, it } from "vitest";
import { LATENCY_BIN_COUNT, type TxnMetricEvent } from "@nymbus/shared";
import { Accumulator } from "./accumulator";

function event(over: Partial<TxnMetricEvent> = {}): TxnMetricEvent {
  return {
    eventId: Math.random().toString(36).slice(2),
    occurredAt: "2026-11-03T12:34:56.789Z",
    tenantId: "t001",
    vendor: "atlas",
    sourceConn: "atlas-1",
    msgType: "0200",
    txnFamily: "purchase",
    outcomeCode: "00",
    amount: 10,
    latencyMs: 120,
    stan: "000001",
    bin: "400000",
    ...over,
  };
}

describe("Accumulator", () => {
  it("floors events into 1-minute and 5-minute buckets", () => {
    const acc = new Accumulator();
    acc.add(event({ occurredAt: "2026-11-03T12:34:56.789Z" }));
    acc.add(event({ occurredAt: "2026-11-03T12:34:01.000Z" }));
    acc.add(event({ occurredAt: "2026-11-03T12:36:00.000Z" }));

    const m1 = [...acc.rollup1m.values()].map((r) => r.bucketTs.toISOString()).sort();
    expect(m1).toEqual(["2026-11-03T12:34:00.000Z", "2026-11-03T12:36:00.000Z"]);
    const m5 = [...acc.rollup5m.values()].map((r) => r.bucketTs.toISOString()).sort();
    expect(m5).toEqual(["2026-11-03T12:30:00.000Z", "2026-11-03T12:35:00.000Z"]);
    const first5 = [...acc.rollup5m.values()].find((r) => r.bucketTs.toISOString() === "2026-11-03T12:30:00.000Z")!;
    expect(first5.count).toBe(2);
  });

  it("keys rollups by every dimension the dashboard slices on", () => {
    const acc = new Accumulator();
    acc.add(event({ outcomeCode: "00" }));
    acc.add(event({ outcomeCode: "51" }));
    acc.add(event({ vendor: "summit" }));
    acc.add(event({ msgType: "0100" }));
    acc.add(event({ txnFamily: "withdrawal" }));
    acc.add(event({ tenantId: "t002" }));
    expect(acc.rollup1m.size).toBe(6);
  });

  it("accumulates additive measures and the latency histogram", () => {
    const acc = new Accumulator();
    acc.add(event({ amount: 10.5, latencyMs: 40 }));
    acc.add(event({ amount: 20.25, latencyMs: 600 }));
    acc.add(event({ amount: 0, latencyMs: 2500 }));
    const r = acc.rollup1m.values().next().value!;
    expect(r.count).toBe(3);
    expect(r.amountSum).toBeCloseTo(30.75);
    expect(r.latencySum).toBe(3140);
    expect(r.latencyMax).toBe(2500);
    expect(r.bins).toHaveLength(LATENCY_BIN_COUNT);
    expect(r.bins[0]).toBe(1); // 40 ms
    expect(r.bins[6]).toBe(1); // 600 ms -> (500, 750]
    expect(r.bins[LATENCY_BIN_COUNT - 1]).toBe(1); // 2500 ms overflow
    expect(r.bins.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it("writes each event into the platform, tenant and vendor live scopes", () => {
    const acc = new Accumulator();
    acc.add(event({ occurredAt: "2026-11-03T12:00:00.100Z", outcomeCode: "00" }));
    acc.add(event({ occurredAt: "2026-11-03T12:00:00.900Z", outcomeCode: "51" }));
    acc.add(event({ occurredAt: "2026-11-03T12:00:00.950Z", outcomeCode: "91" }));
    const sec = Math.floor(Date.parse("2026-11-03T12:00:00.000Z") / 1000);
    const all = acc.live.get(`all|${sec}`)!;
    expect(all).toMatchObject({ n: 3, ok: 1, dec: 1, err: 1 });
    expect(acc.live.get(`t:t001|${sec}`)?.n).toBe(3);
    expect(acc.live.get(`v:atlas|${sec}`)?.n).toBe(3);
    expect(acc.live.size).toBe(3);
  });

  it("tracks the newest event time and ignores unparseable timestamps", () => {
    const acc = new Accumulator();
    acc.add(event({ occurredAt: "2026-11-03T12:00:05.000Z" }));
    acc.add(event({ occurredAt: "2026-11-03T12:00:01.000Z" }));
    acc.add(event({ occurredAt: "not a date" }));
    expect(acc.size).toBe(2);
    expect(new Date(acc.newestEventMs).toISOString()).toBe("2026-11-03T12:00:05.000Z");
  });

  it("is additive: two accumulators flushed separately equal one", () => {
    // This is the property that lets several aggregator replicas UPSERT into the same rows.
    const events = Array.from({ length: 50 }, (_, i) => event({ latencyMs: 50 + i * 10, amount: i, outcomeCode: i % 7 === 0 ? "51" : "00" }));
    const one = new Accumulator();
    const a = new Accumulator();
    const b = new Accumulator();
    events.forEach((e, i) => {
      one.add(e);
      (i % 2 ? a : b).add(e);
    });
    for (const [key, r] of one.rollup1m) {
      const ra = a.rollup1m.get(key);
      const rb = b.rollup1m.get(key);
      expect((ra?.count ?? 0) + (rb?.count ?? 0)).toBe(r.count);
      expect((ra?.amountSum ?? 0) + (rb?.amountSum ?? 0)).toBeCloseTo(r.amountSum);
      expect(Math.max(ra?.latencyMax ?? 0, rb?.latencyMax ?? 0)).toBe(r.latencyMax);
      r.bins.forEach((n, i) => expect((ra?.bins[i] ?? 0) + (rb?.bins[i] ?? 0)).toBe(n));
    }
  });
});
