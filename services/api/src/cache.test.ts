import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TtlCache } from "./cache";

describe("TtlCache", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("collapses concurrent callers onto one in-flight query", async () => {
    const cache = new TtlCache<number>(1500);
    const fn = vi.fn(async () => 42);
    const results = await Promise.all([cache.get("k", fn), cache.get("k", fn), cache.get("k", fn)]);
    expect(results).toEqual([42, 42, 42]);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("serves the cached value until the TTL passes, then refreshes", async () => {
    const cache = new TtlCache<number>(1500);
    let n = 0;
    const fn = vi.fn(async () => ++n);
    expect(await cache.get("k", fn)).toBe(1);
    vi.advanceTimersByTime(1400);
    expect(await cache.get("k", fn)).toBe(1);
    vi.advanceTimersByTime(200);
    expect(await cache.get("k", fn)).toBe(2);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("keys independently", async () => {
    const cache = new TtlCache<string>(1500);
    expect(await cache.get("a", async () => "A")).toBe("A");
    expect(await cache.get("b", async () => "B")).toBe("B");
  });

  it("does not cache a failure", async () => {
    const cache = new TtlCache<number>(1500);
    const fn = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce(7);
    await expect(cache.get("k", fn)).rejects.toThrow("db down");
    expect(await cache.get("k", fn)).toBe(7);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
