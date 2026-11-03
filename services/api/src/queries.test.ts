import { describe, expect, it } from "vitest";
import { buildFilters, planWindow } from "./queries";

const win = (hours: number) => {
  const to = new Date("2026-11-03T12:00:00Z");
  return { from: new Date(to.getTime() - hours * 3600_000), to };
};

describe("planWindow", () => {
  it("reads 1-minute rollups for windows up to two hours", () => {
    expect(planWindow(win(0.25))).toEqual({ table: "txn_rollup_1m", stepSeconds: 60 });
    expect(planWindow(win(1))).toEqual({ table: "txn_rollup_1m", stepSeconds: 60 });
    expect(planWindow(win(2))).toEqual({ table: "txn_rollup_1m", stepSeconds: 60 });
  });

  it("switches to 5-minute rollups with coarser steps as the window grows", () => {
    expect(planWindow(win(6))).toEqual({ table: "txn_rollup_5m", stepSeconds: 300 });
    expect(planWindow(win(24))).toEqual({ table: "txn_rollup_5m", stepSeconds: 900 });
  });

  it("honours a requested step but never finer than the data", () => {
    expect(planWindow(win(24), 30).stepSeconds).toBe(60);
    expect(planWindow(win(24), 60)).toEqual({ table: "txn_rollup_1m", stepSeconds: 60 });
    // Anything over a minute must be a multiple of the 5-minute table's grain.
    expect(planWindow(win(24), 400)).toEqual({ table: "txn_rollup_5m", stepSeconds: 600 });
    expect(planWindow(win(24), 3600)).toEqual({ table: "txn_rollup_5m", stepSeconds: 3600 });
  });
});

describe("buildFilters", () => {
  const w = win(1);

  it("always constrains the time column with half-open bounds", () => {
    const params: unknown[] = [];
    const where = buildFilters({ role: "global" }, {}, params, "bucket_ts", w);
    expect(where).toBe("bucket_ts >= $1 AND bucket_ts < $2");
    expect(params).toEqual([w.from, w.to]);
  });

  it("lets a global operator filter by tenant", () => {
    const params: unknown[] = [];
    const where = buildFilters({ role: "global" }, { tenantId: "t007" }, params, "bucket_ts", w);
    expect(where).toContain("tenant_id = $3");
    expect(params[2]).toBe("t007");
  });

  it("pins a tenant admin to their own tenant even if they ask for another", () => {
    const params: unknown[] = [];
    const where = buildFilters({ role: "tenant", tenantId: "t001" }, { tenantId: "t002" }, params, "occurred_at", w);
    expect(where).toContain("tenant_id = $3");
    expect(params[2]).toBe("t001");
    expect(params).not.toContain("t002");
  });

  it("numbers parameters in order for every dimension", () => {
    const params: unknown[] = [];
    const where = buildFilters(
      { role: "global" },
      { vendor: "atlas", msgType: "0200", txnFamily: "purchase", outcomeCode: "51" },
      params,
      "bucket_ts",
      w,
    );
    expect(where).toBe("bucket_ts >= $1 AND bucket_ts < $2 AND vendor = $3 AND msg_type = $4 AND txn_family = $5 AND outcome_code = $6");
    expect(params.slice(2)).toEqual(["atlas", "0200", "purchase", "51"]);
  });

  it("expands an outcome class into its codes", () => {
    const params: unknown[] = [];
    const where = buildFilters({ role: "global" }, { outcomeClass: "system_error" }, params, "bucket_ts", w);
    expect(where).toContain("outcome_code = ANY($3::text[])");
    expect([...(params[2] as string[])].sort()).toEqual(["91", "96"]);
  });

  it("never interpolates filter values into the SQL text", () => {
    const params: unknown[] = [];
    const where = buildFilters({ role: "global" }, { vendor: "x' OR 1=1 --" }, params, "bucket_ts", w);
    expect(where).not.toContain("OR 1=1");
    expect(params).toContain("x' OR 1=1 --");
  });
});
