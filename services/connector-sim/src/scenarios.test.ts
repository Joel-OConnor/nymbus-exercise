import { describe, expect, it } from "vitest";
import { PRESETS, ScenarioManager } from "./scenarios";

const T0 = new Date("2026-11-03T12:00:00Z");
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);

describe("ScenarioManager", () => {
  it("applies preset magnitude and duration when none are given", () => {
    const m = new ScenarioManager();
    const s = m.add({ type: "latency_spike", tenantId: "t001" }, T0);
    expect(s.magnitude).toBe(PRESETS.latency_spike.magnitude);
    expect(Date.parse(s.endsAt) - Date.parse(s.startedAt)).toBe(PRESETS.latency_spike.durationSec * 1000);
    expect(s.target).toEqual({ tenantId: "t001" });
    expect(s.description).toContain("tenant t001");
  });

  it("clamps duration to a sane range", () => {
    const m = new ScenarioManager();
    expect(Date.parse(m.add({ type: "traffic_surge", durationSec: 1 }, T0).endsAt) - T0.getTime()).toBe(5_000);
    expect(Date.parse(m.add({ type: "traffic_surge", durationSec: 99_999 }, T0).endsAt) - T0.getTime()).toBe(3600_000);
  });

  it("rejects unknown types and untargeted outages", () => {
    const m = new ScenarioManager();
    expect(() => m.add({ type: "meteor" as never }, T0)).toThrow(/unknown scenario type/);
    expect(() => m.add({ type: "outage" }, T0)).toThrow(/requires a tenantId or vendor/);
    expect(() => m.add({ type: "outage", vendor: "summit" }, T0)).not.toThrow();
  });

  it("targets effects at a tenant, a vendor, or everyone", () => {
    const m = new ScenarioManager();
    m.add({ type: "latency_spike", tenantId: "t001", magnitude: 4 }, T0);
    m.add({ type: "decline_spike", vendor: "atlas", magnitude: 0.3 }, T0);
    m.add({ type: "traffic_surge", magnitude: 3 }, T0);

    const t1 = m.effectsFor("t001", "atlas");
    expect(t1).toMatchObject({ latencyMultiplier: 4, declineBoost: 0.3, tpsMultiplier: 3, outage: false });

    const t2 = m.effectsFor("t002", "summit");
    expect(t2).toMatchObject({ latencyMultiplier: 1, declineBoost: 0, tpsMultiplier: 3 });

    const t3 = m.effectsFor("t003", "atlas");
    expect(t3).toMatchObject({ latencyMultiplier: 1, declineBoost: 0.3, tpsMultiplier: 3 });
  });

  it("combines overlapping scenarios: multipliers multiply, fractions add and cap at 1", () => {
    const m = new ScenarioManager();
    m.add({ type: "latency_spike", magnitude: 2 }, T0);
    m.add({ type: "latency_spike", tenantId: "t001", magnitude: 3 }, T0);
    m.add({ type: "system_errors", magnitude: 0.7 }, T0);
    m.add({ type: "system_errors", tenantId: "t001", magnitude: 0.7 }, T0);
    const e = m.effectsFor("t001", "atlas");
    expect(e.latencyMultiplier).toBe(6);
    expect(e.errorBoost).toBe(1);
    expect(m.effectsFor("t002", "atlas").latencyMultiplier).toBe(2);
  });

  it("returns neutral effects with no scenarios, and a shared frozen-looking object", () => {
    const m = new ScenarioManager();
    expect(m.effectsFor("t001", "atlas")).toEqual({ latencyMultiplier: 1, declineBoost: 0, errorBoost: 0, tpsMultiplier: 1, outage: false });
  });

  it("expires scenarios when listed after their end time", () => {
    const m = new ScenarioManager();
    m.add({ type: "latency_spike", durationSec: 60 }, T0);
    expect(m.list(at(59))).toHaveLength(1);
    expect(m.list(at(60))).toHaveLength(0);
    // Once expired, effects are gone too.
    m.add({ type: "latency_spike", durationSec: 60, magnitude: 5 }, T0);
    m.expire(at(61));
    expect(m.effectsFor("t001", "atlas").latencyMultiplier).toBe(1);
  });

  it("removes one or all scenarios", () => {
    const m = new ScenarioManager();
    const a = m.add({ type: "latency_spike" }, T0);
    m.add({ type: "traffic_surge" }, T0);
    expect(m.remove(a.id)).toBe(true);
    expect(m.remove(a.id)).toBe(false);
    expect(m.list(T0)).toHaveLength(1);
    m.clear();
    expect(m.list(T0)).toHaveLength(0);
  });
});
