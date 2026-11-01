import { randomUUID } from "node:crypto";

export type ScenarioType =
  | "latency_spike"
  | "decline_spike"
  | "system_errors"
  | "traffic_surge"
  | "outage";

export interface ScenarioTarget {
  tenantId?: string;
  vendor?: string;
}

export interface Scenario {
  id: string;
  type: ScenarioType;
  target: ScenarioTarget;
  magnitude: number;
  startedAt: string;
  endsAt: string;
  description: string;
}

export interface ScenarioRequest {
  type: ScenarioType;
  tenantId?: string;
  vendor?: string;
  magnitude?: number;
  durationSec?: number;
}

/** What the generator applies to one tenant's traffic on a given tick. */
export interface Effects {
  latencyMultiplier: number;
  /** Fraction of financial messages forced into a soft decline. */
  declineBoost: number;
  /** Fraction of financial messages forced into a system error (91/96). */
  errorBoost: number;
  tpsMultiplier: number;
  outage: boolean;
}

export const PRESETS: Record<ScenarioType, { label: string; magnitude: number; durationSec: number; unit: string; description: string }> = {
  latency_spike: {
    label: "Latency spike",
    magnitude: 4,
    durationSec: 120,
    unit: "x latency",
    description: "Multiplies processing latency for the target. Pushes p95 past the 500 ms budget and surfaces issuer timeouts (91).",
  },
  decline_spike: {
    label: "Decline spike",
    magnitude: 0.35,
    durationSec: 120,
    unit: "fraction declined",
    description: "Forces a share of financial messages into soft declines (51/05/61). Approval rate drops; outcome mix shifts.",
  },
  system_errors: {
    label: "System errors",
    magnitude: 0.25,
    durationSec: 120,
    unit: "fraction errored",
    description: "Forces a share of messages into 91/96. Looks like an issuer or core-banking outage from the operator's seat.",
  },
  traffic_surge: {
    label: "Traffic surge",
    magnitude: 3,
    durationSec: 120,
    unit: "x throughput",
    description: "Multiplies arrival rate. With no target it is platform-wide: 3x takes the default population past 400 tps.",
  },
  outage: {
    label: "Traffic outage",
    magnitude: 1,
    durationSec: 90,
    unit: "",
    description: "The target stops sending entirely. Silence is a signal too: the dashboard should show the gap, not just errors.",
  },
};

const NEUTRAL: Effects = { latencyMultiplier: 1, declineBoost: 0, errorBoost: 0, tpsMultiplier: 1, outage: false };

export class ScenarioManager {
  private scenarios = new Map<string, Scenario>();

  add(req: ScenarioRequest, now = new Date()): Scenario {
    const preset = PRESETS[req.type];
    if (!preset) throw new Error(`unknown scenario type: ${req.type}`);
    if (req.type === "outage" && !req.tenantId && !req.vendor) {
      throw new Error("outage requires a tenantId or vendor target");
    }
    const magnitude = req.magnitude ?? preset.magnitude;
    const durationSec = Math.min(Math.max(req.durationSec ?? preset.durationSec, 5), 3600);
    const target: ScenarioTarget = {};
    if (req.tenantId) target.tenantId = req.tenantId;
    if (req.vendor) target.vendor = req.vendor;
    const scope = target.tenantId ? `tenant ${target.tenantId}` : target.vendor ? `vendor ${target.vendor}` : "platform-wide";
    const s: Scenario = {
      id: randomUUID().slice(0, 8),
      type: req.type,
      target,
      magnitude,
      startedAt: now.toISOString(),
      endsAt: new Date(now.getTime() + durationSec * 1000).toISOString(),
      description: `${preset.label} ${preset.unit ? `${magnitude}${preset.unit.startsWith("x") ? preset.unit : ` ${preset.unit}`}` : ""} on ${scope} for ${durationSec}s`,
    };
    this.scenarios.set(s.id, s);
    return s;
  }

  remove(id: string): boolean {
    return this.scenarios.delete(id);
  }

  clear(): void {
    this.scenarios.clear();
  }

  list(now = new Date()): Scenario[] {
    this.expire(now);
    return [...this.scenarios.values()];
  }

  expire(now = new Date()): void {
    const t = now.getTime();
    for (const [id, s] of this.scenarios) {
      if (Date.parse(s.endsAt) <= t) this.scenarios.delete(id);
    }
  }

  /** Combine every active scenario that targets this tenant, its vendor, or the whole platform. */
  effectsFor(tenantId: string, vendor: string): Effects {
    if (this.scenarios.size === 0) return NEUTRAL;
    const e: Effects = { ...NEUTRAL };
    for (const s of this.scenarios.values()) {
      const matches =
        (s.target.tenantId === undefined || s.target.tenantId === tenantId) &&
        (s.target.vendor === undefined || s.target.vendor === vendor);
      if (!matches) continue;
      switch (s.type) {
        case "latency_spike":
          e.latencyMultiplier *= s.magnitude;
          break;
        case "decline_spike":
          e.declineBoost = Math.min(1, e.declineBoost + s.magnitude);
          break;
        case "system_errors":
          e.errorBoost = Math.min(1, e.errorBoost + s.magnitude);
          break;
        case "traffic_surge":
          e.tpsMultiplier *= s.magnitude;
          break;
        case "outage":
          e.outage = true;
          break;
      }
    }
    return e;
  }
}
