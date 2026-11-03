import { describe, expect, it } from "vitest";
import { PARTITION_SPECS, maintainedRange, retentionHorizon, type PartitionSpec } from "./partitions";

const hourly: PartitionSpec = { table: "txn_rollup_1m", column: "bucket_ts", widthMinutes: 60, retainMinutes: 25 * 60, aheadCount: 2 };
const quarter: PartitionSpec = { table: "txn_event", column: "occurred_at", widthMinutes: 15, retainMinutes: 75, aheadCount: 2 };
const now = new Date("2026-11-03T12:34:56Z");

describe("maintainedRange", () => {
  it("covers one slice behind, the current slice, and aheadCount ahead", () => {
    const r = maintainedRange(hourly, now);
    expect(r.from.toISOString()).toBe("2026-11-03T11:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-11-03T15:00:00.000Z");
  });

  it("aligns to the partition width, not the hour", () => {
    const r = maintainedRange(quarter, now);
    expect(r.from.toISOString()).toBe("2026-11-03T12:15:00.000Z");
    expect(r.to.toISOString()).toBe("2026-11-03T13:15:00.000Z");
  });
});

describe("retentionHorizon", () => {
  it("is now minus the retention period", () => {
    expect(retentionHorizon(hourly, now).toISOString()).toBe("2026-11-02T11:34:56.000Z");
    expect(retentionHorizon(quarter, now).toISOString()).toBe("2026-11-03T11:19:56.000Z");
  });
});

describe("PARTITION_SPECS", () => {
  it("retains strictly more than the longest dashboard window for each table", () => {
    const byTable = new Map(PARTITION_SPECS.map((s) => [s.table, s]));
    // 24 h view + one spare hour so the oldest minute is never mid-drop.
    expect(byTable.get("txn_rollup_1m")!.retainMinutes).toBeGreaterThan(24 * 60);
    expect(byTable.get("txn_rollup_5m")!.retainMinutes).toBeGreaterThan(24 * 60);
    // 1 h of raw events, and the API caps event windows at 75 min.
    expect(byTable.get("txn_event")!.retainMinutes).toBeGreaterThanOrEqual(75);
    for (const s of PARTITION_SPECS) {
      expect(s.retainMinutes % s.widthMinutes).toBe(0);
      expect(s.aheadCount).toBeGreaterThanOrEqual(1);
    }
  });
});
