import type { PoolClient } from "@nymbus/db";
import {
  LATENCY_BIN_COUNT,
  OUTCOME_CODES,
  estimatePercentile,
  type BreakdownRow,
  type DimensionFilters,
  type EventRow,
  type OutcomeClass,
  type OverviewResponse,
  type Scope,
  type TimeseriesPoint,
  type Totals,
} from "@nymbus/shared";

const BIN_COLS = Array.from({ length: LATENCY_BIN_COUNT }, (_, i) => `lat_b${i}`);
const codesOf = (cls: OutcomeClass) => Object.entries(OUTCOME_CODES).filter(([, v]) => v.class === cls).map(([k]) => k);
const SOFT = codesOf("soft_decline");
const HARD = codesOf("hard_decline");
const SYS = codesOf("system_error");
const FMT = codesOf("format_error");

export interface Window {
  from: Date;
  to: Date;
}

/** Pick the rollup table and step for a window. Short windows read 1m rows; long ones read 5m. */
export function planWindow(w: Window, requestedStep?: number): { table: "txn_rollup_1m" | "txn_rollup_5m"; stepSeconds: number } {
  const spanSec = (w.to.getTime() - w.from.getTime()) / 1000;
  let step = requestedStep ?? (spanSec <= 2 * 3600 ? 60 : spanSec <= 8 * 3600 ? 300 : 900);
  if (step < 60) step = 60;
  if (step > 60 && step % 300 !== 0) step = Math.ceil(step / 300) * 300;
  return { table: step === 60 ? "txn_rollup_1m" : "txn_rollup_5m", stepSeconds: step };
}

/** Build the WHERE clause. The caller's scope always wins over a tenantId filter. */
export function buildFilters(scope: Scope, f: DimensionFilters, params: unknown[], tsCol: string, w: Window): string {
  const where: string[] = [];
  params.push(w.from, w.to);
  where.push(`${tsCol} >= $${params.length - 1} AND ${tsCol} < $${params.length}`);
  const tenant = scope.role === "tenant" ? scope.tenantId : f.tenantId;
  if (tenant) where.push(`tenant_id = $${params.push(tenant)}`);
  if (f.vendor) where.push(`vendor = $${params.push(f.vendor)}`);
  if (f.msgType) where.push(`msg_type = $${params.push(f.msgType)}`);
  if (f.txnFamily) where.push(`txn_family = $${params.push(f.txnFamily)}`);
  if (f.outcomeCode) where.push(`outcome_code = $${params.push(f.outcomeCode)}`);
  if (f.outcomeClass) where.push(`outcome_code = ANY($${params.push(codesOf(f.outcomeClass))}::text[])`);
  return where.join(" AND ");
}

const MEASURES = `
  SUM(txn_count)::bigint AS count,
  SUM(CASE WHEN outcome_code = '00' THEN txn_count ELSE 0 END)::bigint AS approved,
  SUM(CASE WHEN outcome_code = ANY($SOFT) THEN txn_count ELSE 0 END)::bigint AS soft_declines,
  SUM(CASE WHEN outcome_code = ANY($HARD) THEN txn_count ELSE 0 END)::bigint AS hard_declines,
  SUM(CASE WHEN outcome_code = ANY($SYS) THEN txn_count ELSE 0 END)::bigint AS system_errors,
  SUM(CASE WHEN outcome_code = ANY($FMT) THEN txn_count ELSE 0 END)::bigint AS format_errors,
  SUM(amount_sum)::numeric AS amount_sum,
  SUM(latency_sum_ms)::bigint AS latency_sum,
  MAX(latency_max_ms)::int AS latency_max,
  ${BIN_COLS.map((c, i) => `SUM(${c})::bigint AS b${i}`).join(",\n  ")}`;

function measures(params: unknown[]): string {
  return MEASURES.replace("$SOFT", `$${params.push(SOFT)}::text[]`)
    .replace("$HARD", `$${params.push(HARD)}::text[]`)
    .replace("$SYS", `$${params.push(SYS)}::text[]`)
    .replace("$FMT", `$${params.push(FMT)}::text[]`);
}

interface MeasureRow {
  count: number;
  approved: number;
  soft_declines: number;
  hard_declines: number;
  system_errors: number;
  format_errors: number;
  amount_sum: number;
  latency_sum: number;
  latency_max: number;
  [k: `b${number}`]: number;
}

function bins(r: MeasureRow): number[] {
  return Array.from({ length: LATENCY_BIN_COUNT }, (_, i) => Number(r[`b${i}`] ?? 0));
}

function toTotals(r: MeasureRow | undefined): Totals {
  if (!r || !r.count) {
    return { count: 0, approved: 0, softDeclines: 0, hardDeclines: 0, systemErrors: 0, formatErrors: 0, amountSum: 0, latencyAvgMs: 0, latencyP50Ms: 0, latencyP95Ms: 0, latencyMaxMs: 0 };
  }
  const b = bins(r);
  return {
    count: r.count,
    approved: r.approved,
    softDeclines: r.soft_declines,
    hardDeclines: r.hard_declines,
    systemErrors: r.system_errors,
    formatErrors: r.format_errors,
    amountSum: Math.round(Number(r.amount_sum) * 100) / 100,
    latencyAvgMs: Math.round(r.latency_sum / r.count),
    latencyP50Ms: estimatePercentile(b, 0.5, r.latency_max),
    latencyP95Ms: estimatePercentile(b, 0.95, r.latency_max),
    latencyMaxMs: r.latency_max,
  };
}

/**
 * One scan, six answers. GROUPING SETS gives the grand total plus a breakdown
 * by each dimension in a single pass over the window, instead of six queries.
 */
export async function overview(client: PoolClient, scope: Scope, f: DimensionFilters, w: Window): Promise<OverviewResponse> {
  const { table } = planWindow(w);
  const params: unknown[] = [];
  const where = buildFilters(scope, f, params, "bucket_ts", w);
  const m = measures(params);
  const sql = `
    SELECT GROUPING(outcome_code, txn_family, msg_type, vendor, tenant_id) AS g,
           outcome_code, txn_family, msg_type, vendor, tenant_id,
           ${m}
      FROM ${table}
     WHERE ${where}
     GROUP BY GROUPING SETS ((), (outcome_code), (txn_family), (msg_type), (vendor), (tenant_id))`;
  const res = await client.query<MeasureRow & { g: number; outcome_code: string | null; txn_family: string | null; msg_type: string | null; vendor: string | null; tenant_id: string | null }>(sql, params);

  const breakdowns: OverviewResponse["breakdowns"] = { outcomeCode: [], txnFamily: [], msgType: [], vendor: [], tenant: [] };
  let totalRow: MeasureRow | undefined;
  const row = (key: string, r: MeasureRow): BreakdownRow => ({ key, count: r.count, approved: r.approved, latencyP95Ms: estimatePercentile(bins(r), 0.95, r.latency_max) });
  for (const r of res.rows) {
    switch (Number(r.g)) {
      case 31: totalRow = r; break;
      case 15: breakdowns.outcomeCode.push(row(r.outcome_code!, r)); break;
      case 23: breakdowns.txnFamily.push(row(r.txn_family!, r)); break;
      case 27: breakdowns.msgType.push(row(r.msg_type!, r)); break;
      case 29: breakdowns.vendor.push(row(r.vendor!, r)); break;
      case 30: breakdowns.tenant.push(row(r.tenant_id!, r)); break;
    }
  }
  const byCount = (a: BreakdownRow, b: BreakdownRow) => b.count - a.count;
  for (const k of Object.keys(breakdowns) as (keyof typeof breakdowns)[]) breakdowns[k].sort(byCount);
  breakdowns.tenant = breakdowns.tenant.slice(0, 15);
  return { range: { from: w.from.toISOString(), to: w.to.toISOString() }, totals: toTotals(totalRow), breakdowns };
}

export async function timeseries(client: PoolClient, scope: Scope, f: DimensionFilters, w: Window, requestedStep?: number) {
  const { table, stepSeconds } = planWindow(w, requestedStep);
  const params: unknown[] = [];
  const where = buildFilters(scope, f, params, "bucket_ts", w);
  const m = measures(params);
  const stepParam = params.push(`${stepSeconds} seconds`);
  const sql = `
    SELECT date_bin($${stepParam}::interval, bucket_ts, TIMESTAMPTZ '2000-01-01') AS ts, ${m}
      FROM ${table}
     WHERE ${where}
     GROUP BY 1 ORDER BY 1`;
  const res = await client.query<MeasureRow & { ts: Date }>(sql, params);
  const byTs = new Map(res.rows.map((r) => [r.ts.getTime(), r]));

  // Gap-fill so an outage is a visible zero, not a missing point.
  const stepMs = stepSeconds * 1000;
  const origin = Date.UTC(2000, 0, 1);
  const start = origin + Math.floor((w.from.getTime() - origin) / stepMs) * stepMs;
  const points: TimeseriesPoint[] = [];
  for (let t = start; t < w.to.getTime(); t += stepMs) {
    const r = byTs.get(t);
    const tot = toTotals(r);
    points.push({ ts: new Date(t).toISOString(), ...tot });
  }
  return { range: { from: w.from.toISOString(), to: w.to.toISOString() }, stepSeconds, source: table === "txn_rollup_1m" ? ("rollup_1m" as const) : ("rollup_5m" as const), points };
}

export async function events(client: PoolClient, scope: Scope, f: DimensionFilters, w: Window, limit: number): Promise<{ events: EventRow[]; truncated: boolean }> {
  const params: unknown[] = [];
  const where = buildFilters(scope, f, params, "occurred_at", w);
  const res = await client.query(
    `SELECT occurred_at, event_id, tenant_id, vendor, source_conn, msg_type, txn_family, outcome_code, amount, latency_ms, stan, bin
       FROM txn_event WHERE ${where}
      ORDER BY occurred_at DESC LIMIT $${params.push(limit + 1)}`,
    params,
  );
  const rows = res.rows.slice(0, limit).map((r) => ({
    eventId: r.event_id,
    occurredAt: (r.occurred_at as Date).toISOString(),
    tenantId: r.tenant_id,
    vendor: r.vendor,
    sourceConn: r.source_conn,
    msgType: r.msg_type,
    txnFamily: r.txn_family,
    outcomeCode: r.outcome_code,
    amount: Number(r.amount),
    latencyMs: r.latency_ms,
    stan: r.stan,
    bin: r.bin,
  }));
  return { events: rows, truncated: res.rows.length > limit };
}
