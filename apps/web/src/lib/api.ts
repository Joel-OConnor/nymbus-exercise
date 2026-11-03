import type {
  EventsResponse,
  FreshnessResponse,
  LiveResponse,
  MetaResponse,
  OverviewResponse,
  Scope,
  TimeseriesResponse,
} from "@nymbus/shared";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type RangeKey = "15m" | "1h" | "6h" | "24h";
export const RANGES: { key: RangeKey; label: string; seconds: number }[] = [
  { key: "15m", label: "15 min", seconds: 900 },
  { key: "1h", label: "1 hour", seconds: 3600 },
  { key: "6h", label: "6 hours", seconds: 6 * 3600 },
  { key: "24h", label: "24 hours", seconds: 24 * 3600 },
];

export interface Filters {
  tenantId?: string;
  vendor?: string;
  msgType?: string;
  txnFamily?: string;
  outcomeCode?: string;
  outcomeClass?: string;
}

function headersFor(scope: Scope): Record<string, string> {
  // In the real console this is the user's session. Here: two headers the API trusts.
  const h: Record<string, string> = { "x-role": scope.role };
  if (scope.role === "tenant" && scope.tenantId) h["x-tenant-id"] = scope.tenantId;
  return h;
}

function qs(params: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : "";
}

async function get<T>(scope: Scope, path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}${qs(params)}`, { headers: headersFor(scope), cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

export const api = {
  meta: (scope: Scope) => get<MetaResponse>(scope, "/api/meta"),
  overview: (scope: Scope, range: RangeKey, f: Filters) => get<OverviewResponse>(scope, "/api/overview", { range, ...f }),
  timeseries: (scope: Scope, range: RangeKey, f: Filters) => get<TimeseriesResponse>(scope, "/api/timeseries", { range, ...f }),
  live: (scope: Scope, f: Filters, seconds = 300, bin = 5) =>
    get<LiveResponse>(scope, "/api/live", { seconds, bin, tenantId: f.tenantId, vendor: f.vendor }),
  events: (scope: Scope, f: Filters, window: { from?: string; to?: string }, limit = 100) =>
    get<EventsResponse>(scope, "/api/events", { ...f, from: window.from, to: window.to, range: window.from ? undefined : "15m", limit }),
  freshness: (scope: Scope) => get<FreshnessResponse>(scope, "/api/freshness"),
  partitions: (scope: Scope) => get<PartitionRow[]>(scope, "/api/admin/partitions"),

  // --- demo-only: traffic simulator control, proxied by the API ---
  simStatus: (scope: Scope) => get<SimStatus>(scope, "/api/sim/status"),
  simPresets: (scope: Scope) => get<SimPreset[]>(scope, "/api/sim/presets"),
  simInject: async (scope: Scope, body: ScenarioRequest) => {
    const res = await fetch(`${API_URL}/api/sim/scenarios`, {
      method: "POST",
      headers: { ...headersFor(scope), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error);
    return res.json() as Promise<Scenario>;
  },
  simCancel: async (scope: Scope, id: string) => {
    const res = await fetch(`${API_URL}/api/sim/scenarios/${id}`, { method: "DELETE", headers: headersFor(scope) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error);
  },
  simCancelAll: async (scope: Scope) => {
    const res = await fetch(`${API_URL}/api/sim/scenarios`, { method: "DELETE", headers: headersFor(scope) });
    if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error);
  },
};

export interface PartitionRow {
  parent: string;
  name: string;
  bound: string;
  bytes: number;
  rows: number;
}

export interface Scenario {
  id: string;
  type: string;
  target: { tenantId?: string; vendor?: string };
  magnitude: number;
  startedAt: string;
  endsAt: string;
  description: string;
}

export interface ScenarioRequest {
  type: string;
  tenantId?: string;
  vendor?: string;
  magnitude?: number;
  durationSec?: number;
}

export interface SimPreset {
  type: string;
  label: string;
  magnitude: number;
  durationSec: number;
  unit: string;
  description: string;
}

export interface SimStatus {
  uptimeSec: number;
  tenantCount: number;
  vendors: string[];
  targetTps: number;
  connector: { processed: number; currentTps: number; emitOverheadMs: { p50: number; p99: number; max: number; samples: number } };
  emitter: { emitted: number; sent: number; dropped: number; failed: number; bufferSize: number; inflight: number; connected: boolean; lastError?: string };
  scenarios: Scenario[];
}
