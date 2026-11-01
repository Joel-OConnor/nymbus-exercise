/**
 * Fixed latency histogram boundaries (ms). Shared by the aggregator (which bins
 * into these), the Postgres rollup columns, the Valkey live buckets, and the OTel
 * histogram, so every tier agrees on what "p95" means.
 */
export const LATENCY_BUCKETS_MS = [50, 100, 150, 200, 300, 500, 750, 1000, 2000] as const;
/** Number of histogram bins: one per boundary plus the overflow bin. */
export const LATENCY_BIN_COUNT = LATENCY_BUCKETS_MS.length + 1;

export function latencyBin(latencyMs: number): number {
  for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
    if (latencyMs <= LATENCY_BUCKETS_MS[i]) return i;
  }
  return LATENCY_BUCKETS_MS.length;
}

/**
 * Estimate a percentile from histogram bin counts using linear interpolation
 * inside the bin. Good to within a bin width, which is what an ops view needs.
 */
export function estimatePercentile(bins: number[], p: number, maxObserved?: number): number {
  const total = bins.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  const target = total * p;
  let cum = 0;
  for (let i = 0; i < bins.length; i++) {
    const prev = cum;
    cum += bins[i];
    if (cum >= target) {
      const lower = i === 0 ? 0 : LATENCY_BUCKETS_MS[i - 1];
      const upper =
        i < LATENCY_BUCKETS_MS.length
          ? LATENCY_BUCKETS_MS[i]
          : Math.max(maxObserved ?? LATENCY_BUCKETS_MS[LATENCY_BUCKETS_MS.length - 1] * 2, lower);
      const frac = bins[i] === 0 ? 0 : (target - prev) / bins[i];
      return Math.round(lower + (upper - lower) * frac);
    }
  }
  return LATENCY_BUCKETS_MS[LATENCY_BUCKETS_MS.length - 1];
}
