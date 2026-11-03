import { LATENCY_BIN_COUNT, latencyBin, outcomeClass, type TxnMetricEvent } from "@nymbus/shared";

/**
 * In-memory accumulation between flushes. Every structure here is additive, so
 * merging it into Postgres (UPSERT ... + EXCLUDED) and Valkey (HINCRBY) is
 * commutative across aggregator instances and safe to replay in the worst case.
 */

export interface RollupAcc {
  bucketTs: Date;
  tenantId: string;
  vendor: string;
  msgType: string;
  txnFamily: string;
  outcomeCode: string;
  count: number;
  amountSum: number;
  latencySum: number;
  latencyMax: number;
  bins: number[];
}

export interface LiveAcc {
  scope: string;
  sec: number;
  n: number;
  ok: number;
  dec: number;
  err: number;
  latSum: number;
  bins: number[];
}

function mergeRollups(into: Map<string, RollupAcc>, from: Map<string, RollupAcc>): void {
  for (const [k, r] of from) {
    const mine = into.get(k);
    if (!mine) {
      into.set(k, { ...r, bins: [...r.bins] });
      continue;
    }
    mine.count += r.count;
    mine.amountSum += r.amountSum;
    mine.latencySum += r.latencySum;
    if (r.latencyMax > mine.latencyMax) mine.latencyMax = r.latencyMax;
    r.bins.forEach((b, i) => (mine.bins[i] += b));
  }
}

/** Events stamped further ahead of this process's clock than this do not move the freshness high-water mark. */
export const MAX_FUTURE_SKEW_MS = 60_000;

export class Accumulator {
  rollup1m = new Map<string, RollupAcc>();
  rollup5m = new Map<string, RollupAcc>();
  live = new Map<string, LiveAcc>();
  events: TxnMetricEvent[] = [];
  /** Newest plausible event time seen; drives the lag gauge and the freshness badge. */
  newestEventMs = 0;

  get size(): number {
    return this.events.length;
  }

  add(e: TxnMetricEvent, now: number = Date.now()): void {
    const ts = Date.parse(e.occurredAt);
    if (Number.isNaN(ts)) return;
    // A badly skewed producer clock must not make the dashboard report "ahead of live" for hours.
    if (ts > this.newestEventMs && ts <= now + MAX_FUTURE_SKEW_MS) this.newestEventMs = ts;

    this.events.push(e);
    this.addRollup(this.rollup1m, e, ts, 60_000);
    this.addRollup(this.rollup5m, e, ts, 300_000);

    const sec = Math.floor(ts / 1000);
    this.addLive("all", sec, e);
    this.addLive(`t:${e.tenantId}`, sec, e);
    this.addLive(`v:${e.vendor}`, sec, e);
  }

  /**
   * Merge another accumulator into this one. Used to re-queue a flush whose
   * Postgres write failed. The Valkey side of that flush ran in parallel and
   * HINCRBY is not idempotent, so the caller passes `live: false` for it; the
   * rollup upserts are retried as a whole because the failed transaction
   * applied none of them.
   */
  absorb(other: Accumulator, opts: { live: boolean }): void {
    for (const e of other.events) this.events.push(e);
    if (other.newestEventMs > this.newestEventMs) this.newestEventMs = other.newestEventMs;
    mergeRollups(this.rollup1m, other.rollup1m);
    mergeRollups(this.rollup5m, other.rollup5m);
    if (!opts.live) return;
    for (const [k, l] of other.live) {
      const mine = this.live.get(k);
      if (!mine) {
        this.live.set(k, { ...l, bins: [...l.bins] });
        continue;
      }
      mine.n += l.n;
      mine.ok += l.ok;
      mine.dec += l.dec;
      mine.err += l.err;
      mine.latSum += l.latSum;
      l.bins.forEach((b, i) => (mine.bins[i] += b));
    }
  }

  private addRollup(map: Map<string, RollupAcc>, e: TxnMetricEvent, ts: number, widthMs: number): void {
    const bucketMs = Math.floor(ts / widthMs) * widthMs;
    const key = `${bucketMs}|${e.tenantId}|${e.vendor}|${e.msgType}|${e.txnFamily}|${e.outcomeCode}`;
    let acc = map.get(key);
    if (!acc) {
      acc = {
        bucketTs: new Date(bucketMs),
        tenantId: e.tenantId,
        vendor: e.vendor,
        msgType: e.msgType,
        txnFamily: e.txnFamily,
        outcomeCode: e.outcomeCode,
        count: 0,
        amountSum: 0,
        latencySum: 0,
        latencyMax: 0,
        bins: new Array(LATENCY_BIN_COUNT).fill(0),
      };
      map.set(key, acc);
    }
    acc.count++;
    acc.amountSum += e.amount;
    acc.latencySum += e.latencyMs;
    if (e.latencyMs > acc.latencyMax) acc.latencyMax = e.latencyMs;
    acc.bins[latencyBin(e.latencyMs)]++;
  }

  private addLive(scope: string, sec: number, e: TxnMetricEvent): void {
    const key = `${scope}|${sec}`;
    let acc = this.live.get(key);
    if (!acc) {
      acc = { scope, sec, n: 0, ok: 0, dec: 0, err: 0, latSum: 0, bins: new Array(LATENCY_BIN_COUNT).fill(0) };
      this.live.set(key, acc);
    }
    acc.n++;
    const cls = outcomeClass(e.outcomeCode);
    if (cls === "approved") acc.ok++;
    else if (cls === "soft_decline" || cls === "hard_decline") acc.dec++;
    else acc.err++;
    acc.latSum += e.latencyMs;
    acc.bins[latencyBin(e.latencyMs)]++;
  }
}
