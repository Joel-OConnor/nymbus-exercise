import { describe, expect, it } from "vitest";
import { LATENCY_BIN_COUNT, LATENCY_BUCKETS_MS, estimatePercentile, latencyBin } from "./latency";

describe("latencyBin", () => {
  it("has one bin per boundary plus an overflow bin", () => {
    expect(LATENCY_BIN_COUNT).toBe(LATENCY_BUCKETS_MS.length + 1);
  });

  it("places values on a boundary in the lower bin (<= semantics)", () => {
    expect(latencyBin(0)).toBe(0);
    expect(latencyBin(50)).toBe(0);
    expect(latencyBin(51)).toBe(1);
    expect(latencyBin(500)).toBe(5);
    expect(latencyBin(501)).toBe(6);
    expect(latencyBin(2000)).toBe(8);
  });

  it("sends anything past the last boundary to the overflow bin", () => {
    expect(latencyBin(2001)).toBe(LATENCY_BUCKETS_MS.length);
    expect(latencyBin(99_999)).toBe(LATENCY_BIN_COUNT - 1);
  });
});

describe("estimatePercentile", () => {
  const empty = new Array(LATENCY_BIN_COUNT).fill(0);

  it("returns 0 for an empty histogram", () => {
    expect(estimatePercentile(empty, 0.95)).toBe(0);
  });

  it("interpolates linearly inside a single bin", () => {
    // 100 samples all in bin 3 (150, 200]: p50 is halfway through the bin.
    const bins = [...empty];
    bins[3] = 100;
    expect(estimatePercentile(bins, 0.5)).toBe(175);
    expect(estimatePercentile(bins, 1)).toBe(200);
  });

  it("p50 never exceeds p95", () => {
    const bins = [10, 20, 30, 25, 10, 3, 1, 1, 0, 0];
    const p50 = estimatePercentile(bins, 0.5);
    const p95 = estimatePercentile(bins, 0.95);
    expect(p50).toBeLessThanOrEqual(p95);
    expect(p50).toBeGreaterThan(50);
    expect(p95).toBeLessThan(500);
  });

  it("uses the observed max as the ceiling of the overflow bin", () => {
    const bins = [...empty];
    bins[LATENCY_BIN_COUNT - 1] = 10;
    // Without a max the overflow bin is assumed to run to 2x the last boundary.
    expect(estimatePercentile(bins, 0.5)).toBe(3000);
    // With one, it is bounded by what was actually seen.
    expect(estimatePercentile(bins, 0.5, 2600)).toBe(2300);
    // A max below the lower bound can't pull the estimate under the bin start.
    expect(estimatePercentile(bins, 0.5, 100)).toBe(2000);
  });

  it("is a reasonable estimate for a known distribution", () => {
    // 95 samples in (50, 100], 5 samples in (500, 750]: p95 is exactly the 100 ms edge,
    // and anything above it walks into the slow bin.
    const bins = [...empty];
    bins[1] = 95;
    bins[6] = 5;
    expect(estimatePercentile(bins, 0.95)).toBe(100);
    expect(estimatePercentile(bins, 0.96)).toBe(550);
    expect(estimatePercentile(bins, 0.99)).toBe(700);
  });
});
