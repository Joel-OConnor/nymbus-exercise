import { describe, expect, it } from "vitest";
import { VENDORS } from "@nymbus/shared";
import { buildTenants } from "./tenants";

describe("buildTenants", () => {
  const tenants = buildTenants(50, 1);

  it("builds the population the brief describes", () => {
    expect(tenants).toHaveLength(50);
    expect(tenants.map((t) => t.tenantId)).toEqual(Array.from({ length: 50 }, (_, i) => `t${String(i + 1).padStart(3, "0")}`));
    for (const t of tenants) {
      expect(Object.keys(VENDORS)).toContain(t.vendor);
      expect(t.bins).toHaveLength(2);
      expect(t.name.length).toBeGreaterThan(3);
    }
  });

  it("lands near the brief's 100-150 tps peak with a few large institutions", () => {
    const total = tenants.reduce((s, t) => s + t.baseTps, 0);
    expect(total).toBeGreaterThan(115);
    expect(total).toBeLessThan(165);
    const large = tenants.filter((t) => t.baseTps >= 13);
    expect(large).toHaveLength(3);
    expect(large[0].tenantId).toBe("t001");
    const small = tenants.filter((t) => t.baseTps < 13);
    for (const t of small) expect(t.baseTps).toBeGreaterThanOrEqual(1.5);
    for (const t of small) expect(t.baseTps).toBeLessThan(2.5);
  });

  it("spreads tenants across every vendor", () => {
    const byVendor = new Map<string, number>();
    for (const t of tenants) byVendor.set(t.vendor, (byVendor.get(t.vendor) ?? 0) + 1);
    expect(byVendor.size).toBe(Object.keys(VENDORS).length);
  });

  it("is deterministic across restarts so tenant ids keep their vendor and size", () => {
    expect(buildTenants(50, 1)).toEqual(tenants);
  });

  it("scales throughput linearly", () => {
    const scaled = buildTenants(50, 2);
    scaled.forEach((t, i) => expect(t.baseTps).toBeCloseTo(tenants[i].baseTps * 2));
  });
});
