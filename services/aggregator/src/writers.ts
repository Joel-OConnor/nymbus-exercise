import type Redis from "ioredis";
import { LATENCY_BIN_COUNT, type TxnMetricEvent } from "@nymbus/shared";
import type { LiveAcc, RollupAcc } from "./accumulator";

/** A pg Pool or a checked-out PoolClient; the flush runs all three Postgres writes on one client inside a transaction. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

const BIN_COLS = Array.from({ length: LATENCY_BIN_COUNT }, (_, i) => `lat_b${i}`);
const ROLLUP_COLS = [
  "bucket_ts", "tenant_id", "vendor", "msg_type", "txn_family", "outcome_code",
  "txn_count", "amount_sum", "latency_sum_ms", "latency_max_ms", ...BIN_COLS,
];
const EVENT_COLS = [
  "occurred_at", "event_id", "tenant_id", "vendor", "source_conn", "msg_type",
  "txn_family", "outcome_code", "amount", "latency_ms", "stan", "bin",
];

function placeholders(rows: number, cols: number): string {
  const out: string[] = [];
  let p = 1;
  for (let r = 0; r < rows; r++) {
    const ph: string[] = [];
    for (let c = 0; c < cols; c++) ph.push(`$${p++}`);
    out.push(`(${ph.join(",")})`);
  }
  return out.join(",");
}

/** Keep each statement under Postgres' 65535 bind-parameter limit. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Additive upsert: counts and sums are added to what is already in the row,
 * max is GREATEST. Any number of aggregator instances can write the same
 * bucket concurrently and the result is the same.
 */
export async function writeRollups(db: Queryable, table: string, rows: RollupAcc[]): Promise<void> {
  if (rows.length === 0) return;
  const updates = [
    "txn_count = t.txn_count + EXCLUDED.txn_count",
    "amount_sum = t.amount_sum + EXCLUDED.amount_sum",
    "latency_sum_ms = t.latency_sum_ms + EXCLUDED.latency_sum_ms",
    "latency_max_ms = GREATEST(t.latency_max_ms, EXCLUDED.latency_max_ms)",
    ...BIN_COLS.map((c) => `${c} = t.${c} + EXCLUDED.${c}`),
  ].join(", ");
  for (const part of chunk(rows, 1000)) {
    const values: unknown[] = [];
    for (const r of part) {
      values.push(r.bucketTs, r.tenantId, r.vendor, r.msgType, r.txnFamily, r.outcomeCode, r.count, r.amountSum.toFixed(2), r.latencySum, r.latencyMax, ...r.bins);
    }
    await db.query(
      `INSERT INTO ${table} AS t (${ROLLUP_COLS.join(",")}) VALUES ${placeholders(part.length, ROLLUP_COLS.length)}
       ON CONFLICT (bucket_ts, tenant_id, vendor, msg_type, txn_family, outcome_code) DO UPDATE SET ${updates}`,
      values,
    );
  }
}

/** Raw events; ON CONFLICT DO NOTHING makes a replay after a crash exact rather than duplicated. */
export async function writeEvents(db: Queryable, events: TxnMetricEvent[]): Promise<void> {
  if (events.length === 0) return;
  for (const part of chunk(events, 2000)) {
    const values: unknown[] = [];
    for (const e of part) {
      values.push(e.occurredAt, e.eventId, e.tenantId, e.vendor, e.sourceConn, e.msgType, e.txnFamily, e.outcomeCode, e.amount.toFixed(2), e.latencyMs, e.stan, e.bin);
    }
    await db.query(
      `INSERT INTO txn_event (${EVENT_COLS.join(",")}) VALUES ${placeholders(part.length, EVENT_COLS.length)}
       ON CONFLICT (occurred_at, event_id) DO NOTHING`,
      values,
    );
  }
}

/** Per-second live buckets in Valkey: one hash per (scope, second), HINCRBY per field, short TTL. */
export async function writeLive(redis: Redis, rows: LiveAcc[], ttlSec: number): Promise<void> {
  if (rows.length === 0) return;
  const pipe = redis.pipeline();
  for (const r of rows) {
    const key = `live:${r.scope}:${r.sec}`;
    pipe.hincrby(key, "n", r.n);
    if (r.ok) pipe.hincrby(key, "ok", r.ok);
    if (r.dec) pipe.hincrby(key, "dec", r.dec);
    if (r.err) pipe.hincrby(key, "err", r.err);
    pipe.hincrby(key, "lat", r.latSum);
    for (let i = 0; i < r.bins.length; i++) if (r.bins[i]) pipe.hincrby(key, `b${i}`, r.bins[i]);
    pipe.expire(key, ttlSec);
  }
  await pipe.exec();
}

/** Heartbeat so the API can show "N seconds behind live" and which instances are alive. */
export async function writeHeartbeat(redis: Redis, instance: string, newestEventMs: number, processed: number): Promise<void> {
  await redis.hset(
    "metrics:aggregators",
    instance,
    JSON.stringify({ lastEventAt: newestEventMs ? new Date(newestEventMs).toISOString() : null, flushedAt: new Date().toISOString(), processed }),
  );
  await redis.expire("metrics:aggregators", 120);
}
