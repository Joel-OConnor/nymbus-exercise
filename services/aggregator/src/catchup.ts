import { PARTITION_SPECS, maintainedRange, retentionHorizon, type PartitionSpec } from "@nymbus/db";
import type { TxnMetricEvent } from "@nymbus/shared";
import type { RollupAcc } from "./accumulator";

/**
 * Decide what a flush needs before it can be written. In steady state every
 * row falls inside the partitions the maintenance loop keeps ready and nothing
 * here does anything. After an outage the aggregator replays hours of Kafka:
 * rollup buckets may predate the ready partitions (create them first), and raw
 * events may be older than the 75-minute raw retention (writing them would fail
 * on a dropped partition or be dropped a minute later; skip them, keep their
 * rollups).
 */
export interface FlushPlan {
  rollup1m: RollupAcc[];
  rollup5m: RollupAcc[];
  events: TxnMetricEvent[];
  /** Partition ranges to create before writing, one entry per table that needs it. */
  ensure: { spec: PartitionSpec; from: Date; to: Date }[];
  expiredRollups: number;
  expiredEvents: number;
}

function span(times: number[]): { min: number; max: number } | undefined {
  if (times.length === 0) return undefined;
  let min = times[0];
  let max = times[0];
  for (const t of times) {
    if (t < min) min = t;
    if (t > max) max = t;
  }
  return { min, max };
}

export function planFlush(
  input: { rollup1m: RollupAcc[]; rollup5m: RollupAcc[]; events: TxnMetricEvent[] },
  now: Date = new Date(),
  specs: PartitionSpec[] = PARTITION_SPECS,
): FlushPlan {
  const specFor = (table: string): PartitionSpec => {
    const s = specs.find((x) => x.table === table);
    if (!s) throw new Error(`no partition spec for ${table}`);
    return s;
  };
  const ensure: FlushPlan["ensure"] = [];
  const needEnsure = (spec: PartitionSpec, times: number[]) => {
    const sp = span(times);
    if (!sp) return;
    const ready = maintainedRange(spec, now);
    if (sp.min >= ready.from.getTime() && sp.max < ready.to.getTime()) return;
    ensure.push({ spec, from: new Date(sp.min), to: new Date(sp.max) });
  };

  let expiredRollups = 0;
  const keepRollups = (rows: RollupAcc[], spec: PartitionSpec): RollupAcc[] => {
    const horizon = retentionHorizon(spec, now).getTime();
    const kept = rows.filter((r) => r.bucketTs.getTime() >= horizon);
    expiredRollups += rows.length - kept.length;
    needEnsure(spec, kept.map((r) => r.bucketTs.getTime()));
    return kept;
  };
  const rollup1m = keepRollups(input.rollup1m, specFor("txn_rollup_1m"));
  const rollup5m = keepRollups(input.rollup5m, specFor("txn_rollup_5m"));

  const eventSpec = specFor("txn_event");
  const eventHorizon = retentionHorizon(eventSpec, now).getTime();
  const events = input.events.filter((e) => Date.parse(e.occurredAt) >= eventHorizon);
  needEnsure(eventSpec, events.map((e) => Date.parse(e.occurredAt)));

  return { rollup1m, rollup5m, events, ensure, expiredRollups, expiredEvents: input.events.length - events.length };
}
