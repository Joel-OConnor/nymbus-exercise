import type Redis from "ioredis";
import { LATENCY_BIN_COUNT, estimatePercentile, type LivePoint, type LiveResponse } from "@nymbus/shared";

/**
 * Read the per-second buckets the aggregator keeps in Valkey and re-bin them.
 * Scope is one of: all, t:<tenant>, v:<vendor>. Live is intentionally coarse;
 * full dimensional drill-down is the rollup store's job. Only complete bins are
 * returned, and the newest seconds are left out: a second's events arrive via
 * the emitter drain (250 ms), Kafka, and the aggregator's 1 s flush, so the
 * last ~2 s are still being written when the API reads.
 */
export async function readLive(redis: Redis, scope: string, seconds: number, binSeconds: number): Promise<LiveResponse> {
  const nowSec = Math.floor(Date.now() / 1000) - 3; // see above: these seconds are still in flight
  const endBin = Math.floor(nowSec / binSeconds) * binSeconds; // exclusive
  const binCount = Math.ceil(seconds / binSeconds);
  const startBin = endBin - binCount * binSeconds;

  const pipe = redis.pipeline();
  for (let s = startBin; s < endBin; s++) pipe.hgetall(`live:${scope}:${s}`);
  const results = (await pipe.exec()) ?? [];

  const points: LivePoint[] = [];
  for (let b = startBin; b < endBin; b += binSeconds) {
    let n = 0, ok = 0, dec = 0, err = 0, lat = 0;
    const bins = new Array<number>(LATENCY_BIN_COUNT).fill(0);
    for (let s = b; s < b + binSeconds; s++) {
      const h = results[s - startBin]?.[1] as Record<string, string> | null;
      if (!h || !h.n) continue;
      n += Number(h.n);
      ok += Number(h.ok ?? 0);
      dec += Number(h.dec ?? 0);
      err += Number(h.err ?? 0);
      lat += Number(h.lat ?? 0);
      for (let i = 0; i < LATENCY_BIN_COUNT; i++) bins[i] += Number(h[`b${i}`] ?? 0);
    }
    points.push({
      ts: new Date(b * 1000).toISOString(),
      count: n,
      approved: ok,
      declined: dec,
      errors: err,
      latencyAvgMs: n ? Math.round(lat / n) : 0,
      latencyP95Ms: estimatePercentile(bins, 0.95),
    });
  }
  return { scope, binSeconds, points };
}
