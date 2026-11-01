import type { LiveResponse, OverviewResponse } from "@nymbus/shared";
import { RANGES, type RangeKey } from "@/lib/api";
import { fmtCompact, fmtMoney, fmtMs, fmtPct, LATENCY_BUDGET_MS } from "@/lib/format";

function Tile({ label, value, sub, tone = "" }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="panel px-3 py-2.5">
      <div className="panel-title">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

export function KpiTiles({ overview, live, range }: { overview?: OverviewResponse; live?: LiveResponse; range: RangeKey }) {
  const t = overview?.totals;
  const seconds = RANGES.find((r) => r.key === range)?.seconds ?? 3600;
  const last = live?.points.at(-1);
  const nowTps = last && live ? last.count / live.binSeconds : undefined;
  const declines = (t?.softDeclines ?? 0) + (t?.hardDeclines ?? 0);
  const errors = (t?.systemErrors ?? 0) + (t?.formatErrors ?? 0);
  const p95 = t?.latencyP95Ms ?? 0;
  const p95Tone = p95 > LATENCY_BUDGET_MS ? "text-rose-400" : p95 > LATENCY_BUDGET_MS * 0.7 ? "text-amber-300" : "text-emerald-300";
  const approvalRate = t ? (100 * t.approved) / Math.max(1, t.count) : 0;

  return (
    <div className="grid grid-cols-2 gap-2 px-4 md:grid-cols-3 xl:grid-cols-6">
      <Tile label="Throughput" value={nowTps !== undefined ? `${nowTps.toFixed(1)} tps` : "–"} sub={t ? `${(t.count / seconds).toFixed(1)} tps avg · ${fmtCompact(t.count)} txns` : undefined} />
      <Tile label="Approval rate" value={t ? `${approvalRate.toFixed(1)}%` : "–"} sub={t ? `${fmtCompact(t.approved)} approved` : undefined} tone={approvalRate < 85 && t?.count ? "text-amber-300" : ""} />
      <Tile label="p95 latency" value={t ? fmtMs(p95) : "–"} sub={t ? `p50 ${fmtMs(t.latencyP50Ms)} · max ${fmtMs(t.latencyMaxMs)} · budget ${LATENCY_BUDGET_MS} ms` : undefined} tone={t?.count ? p95Tone : ""} />
      <Tile label="Declines" value={t ? fmtCompact(declines) : "–"} sub={t ? `${fmtPct(declines, t.count)} · ${fmtCompact(t.softDeclines)} soft / ${fmtCompact(t.hardDeclines)} hard` : undefined} />
      <Tile label="System errors" value={t ? fmtCompact(errors) : "–"} sub={t ? `${fmtPct(errors, t.count, 2)} of traffic` : undefined} tone={t && t.count && errors / t.count > 0.02 ? "text-rose-400" : ""} />
      <Tile label="Volume" value={t ? fmtMoney(t.amountSum) : "–"} sub="financial messages, this range" />
    </div>
  );
}
