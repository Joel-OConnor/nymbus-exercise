import { describe, expect, it } from "vitest";
import { summarizeFreshness } from "./freshness";

const now = Date.parse("2026-11-03T12:00:00Z");
const iso = (secAgo: number) => new Date(now - secAgo * 1000).toISOString();
const hb = (lastEventSecAgo: number | null, flushedSecAgo = 1, processed = 100) =>
  JSON.stringify({ lastEventAt: lastEventSecAgo === null ? null : iso(lastEventSecAgo), flushedAt: iso(flushedSecAgo), processed });

describe("summarizeFreshness", () => {
  it("reports null when no aggregator is alive", () => {
    expect(summarizeFreshness({}, now)).toEqual({ lagSeconds: null, lastEventAt: null, aggregators: [] });
  });

  it("reports one replica's lag to a tenth of a second", () => {
    const f = summarizeFreshness({ a: hb(1.26) }, now);
    expect(f.lagSeconds).toBe(1.3);
    expect(f.lastEventAt).toBe(iso(1.26));
    expect(f.aggregators).toHaveLength(1);
  });

  it("reports the slowest live replica, not the fastest", () => {
    const f = summarizeFreshness({ fast: hb(1), stalled: hb(95) }, now);
    expect(f.lagSeconds).toBe(95);
    expect(f.aggregators.map((a) => a.instance)).toEqual(["fast", "stalled"]);
  });

  it("drops replicas whose heartbeat is stale", () => {
    const f = summarizeFreshness({ alive: hb(2, 5), dead: hb(400, 60) }, now);
    expect(f.aggregators.map((a) => a.instance)).toEqual(["alive"]);
    expect(f.lagSeconds).toBe(2);
  });

  it("ignores a replica that has not processed anything yet when computing lag", () => {
    const f = summarizeFreshness({ fresh: hb(null, 1, 0), busy: hb(3) }, now);
    expect(f.aggregators).toHaveLength(2);
    expect(f.lagSeconds).toBe(3);
  });

  it("never reports a negative lag when a replica's clock is ahead", () => {
    expect(summarizeFreshness({ a: hb(-4) }, now).lagSeconds).toBe(0);
  });

  it("survives a corrupt heartbeat entry", () => {
    const f = summarizeFreshness({ ok: hb(2), bad: "not json", worse: JSON.stringify({ nope: 1 }) }, now);
    expect(f.aggregators.map((a) => a.instance)).toEqual(["ok"]);
    expect(f.lagSeconds).toBe(2);
  });
});
