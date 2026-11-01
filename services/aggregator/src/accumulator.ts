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

export class Accumulator {
  rollup1m = new Map<string, RollupAcc>();
  rollup5m = new Map<string, RollupAcc>();
  live = new Map<string, LiveAcc>();
  events: TxnMetricEvent[] = [];
  newestEventMs = 0;

  get size(): number {
    return this.events.length;
  }

  add(e: TxnMetricEvent): void {
    const ts = Date.parse(e.occurredAt);
    if (Number.isNaN(ts)) return;
    if (ts > this.newestEventMs) this.newestEventMs = ts;

    this.events.push(e);
    this.addRollup(this.rollup1m, e, ts, 60_000);
    this.addRollup(this.rollup5m, e, ts, 300_000);

    const sec = Math.floor(ts / 1000);
    this.addLive("all", sec, e);
    this.addLive(`t:${e.tenantId}`, sec, e);
    this.addLive(`v:${e.vendor}`, sec, e);
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
