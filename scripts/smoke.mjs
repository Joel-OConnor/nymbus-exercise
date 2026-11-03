#!/usr/bin/env node
/**
 * End-to-end smoke test against a running stack (`npm run infra:up && npm run dev`).
 * Checks every API route, scope enforcement and tenant isolation, the live
 * pipeline (sim -> Kafka -> aggregator -> Postgres/Valkey), the sim proxy
 * round trip, CORS for the console, and the long-term path (collector,
 * Prometheus, Grafana). Exit code 1 on any failure. Run it before a demo.
 */
const API = process.env.API_URL ?? "http://localhost:4000";
const SIM = process.env.SIM_CONTROL_URL ?? "http://localhost:4100";
const WEB = process.env.WEB_URL ?? "http://localhost:3000";
const GRAFANA = process.env.GRAFANA_URL ?? "http://localhost:3001";
const PROM = process.env.PROMETHEUS_URL ?? "http://localhost:9090";
const COLLECTOR = process.env.COLLECTOR_METRICS_URL ?? "http://localhost:8889/metrics";

const GLOBAL = { "x-role": "global" };
const TENANT = { "x-role": "tenant", "x-tenant-id": "t001" };

let failures = 0;
const results = [];

async function check(name, fn) {
  const t0 = performance.now();
  try {
    const detail = await fn();
    results.push({ ok: true, name, ms: performance.now() - t0, detail });
  } catch (err) {
    failures++;
    results.push({ ok: false, name, ms: performance.now() - t0, detail: err.message });
  }
}

async function req(base, path, { headers = {}, method = "GET", body, expect = 200 } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status !== expect) throw new Error(`${method} ${path}: expected ${expect}, got ${res.status} ${(await res.text()).slice(0, 120)}`);
  const ct = res.headers.get("content-type") ?? "";
  return ct.includes("json") ? res.json() : res.text();
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// --- services up -----------------------------------------------------------
await check("API health", async () => (await req(API, "/health")).service);
await check("Simulator health", async () => (await req(SIM, "/health")).service);
await check("Console renders", async () => {
  const html = await req(WEB, "/");
  assert(typeof html === "string" && html.includes("<html"), "no HTML from console");
  return `${html.length} bytes`;
});

// --- identity and scope ----------------------------------------------------
await check("Anonymous request rejected (401)", () => req(API, "/api/me", { expect: 401 }));
await check("Tenant role without id rejected (401)", () => req(API, "/api/me", { headers: { "x-role": "tenant" }, expect: 401 }));
await check("Global scope resolves", async () => {
  const me = await req(API, "/api/me", { headers: GLOBAL });
  assert(me.role === "global", JSON.stringify(me));
});
await check("Tenant scope resolves", async () => {
  const me = await req(API, "/api/me", { headers: TENANT });
  assert(me.role === "tenant" && me.tenantId === "t001", JSON.stringify(me));
});
await check("Admin route refused to tenant (403)", () => req(API, "/api/admin/partitions", { headers: TENANT, expect: 403 }));

// --- read paths ------------------------------------------------------------
await check("Meta lists tenants and dimensions", async () => {
  const m = await req(API, "/api/meta", { headers: GLOBAL });
  assert(m.tenants.length >= 50, `only ${m.tenants.length} tenants`);
  assert(m.vendors.length === 5 && m.outcomeCodes.length >= 15, "dimension lists short");
  return `${m.tenants.length} tenants`;
});
for (const range of ["15m", "1h", "24h"]) {
  await check(`Overview ${range} has traffic`, async () => {
    const o = await req(API, `/api/overview?range=${range}`, { headers: GLOBAL });
    assert(o.totals.count > 0, "zero transactions");
    assert(o.totals.approved <= o.totals.count, "approved > count");
    assert(o.breakdowns.vendor.length >= 1 && o.breakdowns.tenant.length >= 1, "empty breakdowns");
    return `${o.totals.count} txns, p95 ${o.totals.latencyP95Ms} ms`;
  });
}
await check("Timeseries 1h is gap-filled at 60 s", async () => {
  const s = await req(API, "/api/timeseries?range=1h", { headers: GLOBAL });
  assert(s.stepSeconds === 60 && s.source === "rollup_1m", `${s.source}/${s.stepSeconds}`);
  assert(s.points.length >= 59 && s.points.length <= 61, `${s.points.length} points`);
  return `${s.points.length} points`;
});
await check("Timeseries 24h reads 5m rollups at 900 s", async () => {
  const s = await req(API, "/api/timeseries?range=24h", { headers: GLOBAL });
  assert(s.stepSeconds === 900 && s.source === "rollup_5m", `${s.source}/${s.stepSeconds}`);
  assert(s.points.length === 96 || s.points.length === 97, `${s.points.length} points`);
});
await check("Events: newest first, within 15 min", async () => {
  const e = await req(API, "/api/events?range=15m&limit=50", { headers: GLOBAL });
  assert(e.events.length === 50, `${e.events.length} rows`);
  for (let i = 1; i < e.events.length; i++) assert(e.events[i - 1].occurredAt >= e.events[i].occurredAt, "not sorted desc");
  assert(Date.now() - Date.parse(e.events[0].occurredAt) < 60_000, "newest event is stale");
  return `newest ${Math.round((Date.now() - Date.parse(e.events[0].occurredAt)) / 1000)} s old`;
});
await check("Events: explicit window matches the rollup for that minute", async () => {
  // Pick the most recent complete, flushed 1-minute bucket and compare tiers:
  // raw rows in that minute must equal the rollup count for it.
  const s = await req(API, "/api/timeseries?range=15m", { headers: GLOBAL });
  const cutoff = Date.now() - 20_000;
  const point = [...s.points].reverse().find((p) => p.count > 0 && Date.parse(p.ts) + 60_000 <= cutoff);
  assert(point, "no complete 1-minute bucket with traffic yet (stack just started?)");
  const from = point.ts;
  const to = new Date(Date.parse(point.ts) + 60_000).toISOString();
  const e = await req(API, `/api/events?from=${from}&to=${to}&limit=500`, { headers: GLOBAL });
  for (const ev of e.events) assert(ev.occurredAt >= from && ev.occurredAt < to, "event outside window");
  if (point.count <= 500) assert(e.events.length === point.count && !e.truncated, `raw ${e.events.length} vs rollup ${point.count}`);
  else assert(e.events.length === 500 && e.truncated, `expected 500 truncated rows, got ${e.events.length}`);
  return `${from.slice(11, 16)}Z: rollup ${point.count}, raw ${e.events.length}${e.truncated ? "+ (truncated)" : ""}`;
});
await check("Live strip has fresh per-second bins", async () => {
  const l = await req(API, "/api/live?seconds=60&bin=5", { headers: GLOBAL });
  assert(l.points.length >= 10, `${l.points.length} points`);
  const recent = l.points.slice(-3).reduce((s, p) => s + p.count, 0);
  assert(recent > 0, "no traffic in the last 15 s of live bins");
  return `${recent} txns in last 3 bins`;
});
await check("Freshness lag under 10 s", async () => {
  const f = await req(API, "/api/freshness", { headers: GLOBAL });
  assert(f.lagSeconds !== null && f.lagSeconds < 10, `lag ${f.lagSeconds}`);
  assert(f.aggregators.length >= 1, "no aggregator heartbeat");
  return `lag ${f.lagSeconds} s, ${f.aggregators.length} aggregator(s)`;
});
await check("Partitions exist for all three tables", async () => {
  const p = await req(API, "/api/admin/partitions", { headers: GLOBAL });
  const parents = new Set(p.map((r) => r.parent));
  assert(["txn_rollup_1m", "txn_rollup_5m", "txn_event"].every((t) => parents.has(t)), [...parents].join(","));
  return `${p.length} partitions`;
});
await check("Bad range rejected (400)", () => req(API, "/api/overview?from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z", { headers: GLOBAL, expect: 400 }));
await check("Unknown route (404)", () => req(API, "/api/nope", { headers: GLOBAL, expect: 404 }));

// --- tenant isolation ------------------------------------------------------
await check("Tenant admin sees only their rows (events)", async () => {
  const e = await req(API, "/api/events?range=15m&limit=500", { headers: TENANT });
  const seen = new Set(e.events.map((x) => x.tenantId));
  assert(e.events.length > 0 && seen.size === 1 && seen.has("t001"), [...seen].join(","));
  return `${e.events.length} rows, all t001`;
});
await check("Tenant admin cannot widen scope via tenantId filter", async () => {
  const o = await req(API, "/api/overview?range=15m&tenantId=t002", { headers: TENANT });
  assert(o.breakdowns.tenant.every((r) => r.key === "t001"), JSON.stringify(o.breakdowns.tenant.map((r) => r.key)));
  const g = await req(API, "/api/overview?range=15m&tenantId=t001", { headers: GLOBAL });
  assert(Math.abs(g.totals.count - o.totals.count) <= Math.max(50, g.totals.count * 0.05), `global t001 ${g.totals.count} vs tenant ${o.totals.count}`);
});
await check("Platform tenant hidden from tenant admins", async () => {
  const o = await req(API, "/api/overview?range=15m", { headers: TENANT });
  assert(!o.breakdowns.msgType.some((r) => r.key === "0800"), "tenant sees network-management traffic");
});

// --- sim control round trip (through the proxy, like the console) -----------
await check("Sim proxy: status", async () => {
  const s = await req(API, "/api/sim/status", { headers: GLOBAL });
  assert(s.tenantCount === 50 && s.emitter.connected === true, JSON.stringify({ tenants: s.tenantCount, kafka: s.emitter.connected }));
  assert(s.connector.emitOverheadMs.p99 < 0.5, `hot-path p99 ${s.connector.emitOverheadMs.p99} ms`);
  return `${s.connector.currentTps} tps, emit p99 ${s.connector.emitOverheadMs.p99} ms, dropped ${s.emitter.dropped}`;
});
await check("Sim proxy: inject then cancel a scenario", async () => {
  const s = await req(API, "/api/sim/scenarios", { headers: GLOBAL, method: "POST", body: { type: "latency_spike", tenantId: "t050", durationSec: 5 }, expect: 201 });
  assert(s.id && s.target.tenantId === "t050", JSON.stringify(s));
  const list = await req(API, "/api/sim/scenarios", { headers: GLOBAL });
  assert(list.some((x) => x.id === s.id), "scenario not listed");
  const del = await req(API, `/api/sim/scenarios/${s.id}`, { headers: GLOBAL, method: "DELETE" });
  assert(del.removed === s.id, JSON.stringify(del));
  await req(API, `/api/sim/scenarios/${s.id}`, { headers: GLOBAL, method: "DELETE", expect: 404 });
});
await check("Sim proxy: validation errors pass through (400)", () =>
  req(API, "/api/sim/scenarios", { headers: GLOBAL, method: "POST", body: { type: "outage" }, expect: 400 }));
await check("CORS preflight allows the console to DELETE", async () => {
  const res = await fetch(`${API}/api/sim/scenarios/x`, {
    method: "OPTIONS",
    headers: { Origin: WEB, "Access-Control-Request-Method": "DELETE", "Access-Control-Request-Headers": "x-role,x-tenant-id" },
  });
  const methods = res.headers.get("access-control-allow-methods") ?? "";
  assert(res.status === 204 && /DELETE/.test(methods), `${res.status} ${methods}`);
  return methods;
});

// --- long-term path --------------------------------------------------------
await check("OTel collector exposes transaction metrics", async () => {
  const text = await req(COLLECTOR, "");
  const n = text.split("\n").filter((l) => l.startsWith("txn_count_total")).length;
  assert(n > 0, "no txn_count_total series");
  return `${n} series`;
});
await check("Prometheus is scraping and sees live tps", async () => {
  const r = await req(PROM, `/api/v1/query?query=${encodeURIComponent("sum(rate(txn_count_total[1m]))")}`);
  const v = Number(r.data.result[0]?.value?.[1] ?? 0);
  assert(v > 10, `rate ${v}`);
  return `${v.toFixed(1)} tps`;
});
await check("Grafana up with provisioned dashboard", async () => {
  await req(GRAFANA, "/api/health");
  const d = await req(GRAFANA, "/api/dashboards/uid/txn-longterm", { headers: { Authorization: "Basic " + Buffer.from("admin:admin").toString("base64") } });
  assert(d.dashboard?.uid === "txn-longterm", "dashboard missing");
  return d.dashboard.title;
});

// --- report ----------------------------------------------------------------
for (const r of results) {
  const mark = r.ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${r.name.padEnd(52)} ${String(Math.round(r.ms)).padStart(5)} ms  ${r.detail ?? ""}`);
}
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
