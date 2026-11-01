"use client";

import type { BreakdownRow, MetaResponse, OverviewResponse, Scope } from "@nymbus/shared";
import { outcomeClass } from "@nymbus/shared";
import { Panel } from "./Panel";
import type { Filters } from "@/lib/api";
import { fmtCompact, fmtMs, fmtPct, OUTCOME_CLASS_COLORS } from "@/lib/format";

function Rows({ rows, total, labelOf, colorOf, active, onPick, max = 8 }: { rows: BreakdownRow[]; total: number; labelOf: (k: string) => string; colorOf?: (k: string) => string; active?: string; onPick: (k: string) => void; max?: number }) {
  if (!rows.length) return <div className="py-4 text-center text-xs text-slate-500">no data</div>;
  const top = rows[0]?.count || 1;
  return (
    <ul className="space-y-1">
      {rows.slice(0, max).map((r) => (
        <li key={r.key}>
          <button
            className={`group grid w-full grid-cols-[1fr_auto] items-center gap-x-2 rounded px-1 py-0.5 text-left text-xs hover:bg-panel-2 ${active === r.key ? "bg-panel-2 ring-1 ring-accent" : ""}`}
            onClick={() => onPick(r.key)}
            title="click to filter"
          >
            <span className="truncate text-slate-200">{labelOf(r.key)}</span>
            <span className="tabular-nums text-slate-300">
              {fmtCompact(r.count)} <span className="text-slate-500">· {fmtPct(r.count, total)}</span> <span className="text-slate-500">· p95 {fmtMs(r.latencyP95Ms)}</span>
            </span>
            <span className="col-span-2 mt-0.5 h-1 w-full rounded bg-panel-2">
              <span className="block h-1 rounded" style={{ width: `${(100 * r.count) / top}%`, background: colorOf?.(r.key) ?? "#60a5fa" }} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function Breakdowns({ scope, overview, meta, filters, onFilters }: { scope: Scope; overview?: OverviewResponse; meta?: MetaResponse; filters: Filters; onFilters: (f: Filters) => void }) {
  const total = overview?.totals.count ?? 0;
  const b = overview?.breakdowns;
  const tenantName = (id: string) => meta?.tenants.find((t) => t.tenantId === id)?.name;
  const toggle = (k: keyof Filters, v: string) => onFilters({ ...filters, [k]: filters[k] === v ? undefined : v, ...(k === "outcomeCode" ? { outcomeClass: undefined } : {}) });

  return (
    <div className={`grid grid-cols-1 gap-2 px-4 md:grid-cols-2 ${scope.role === "global" ? "xl:grid-cols-5" : "xl:grid-cols-4"}`}>
      <Panel title="By outcome">
        <Rows rows={b?.outcomeCode ?? []} total={total} active={filters.outcomeCode} onPick={(k) => toggle("outcomeCode", k)} labelOf={(k) => `${k} · ${meta?.outcomeCodes.find((o) => o.key === k)?.label ?? ""}`} colorOf={(k) => OUTCOME_CLASS_COLORS[outcomeClass(k)]} />
      </Panel>
      <Panel title="By family">
        <Rows rows={b?.txnFamily ?? []} total={total} active={filters.txnFamily} onPick={(k) => toggle("txnFamily", k)} labelOf={(k) => meta?.txnFamilies.find((f) => f.key === k)?.label ?? k} />
      </Panel>
      <Panel title="By message type">
        <Rows rows={b?.msgType ?? []} total={total} active={filters.msgType} onPick={(k) => toggle("msgType", k)} labelOf={(k) => `${k} · ${meta?.msgTypes.find((m) => m.key === k)?.label ?? ""}`} />
      </Panel>
      <Panel title="By vendor">
        <Rows rows={b?.vendor ?? []} total={total} active={filters.vendor} onPick={(k) => toggle("vendor", k)} labelOf={(k) => meta?.vendors.find((v) => v.key === k)?.label ?? k} />
      </Panel>
      {scope.role === "global" && (
        <Panel title="Top tenants" right="by volume">
          <Rows rows={b?.tenant ?? []} total={total} active={filters.tenantId} onPick={(k) => toggle("tenantId", k)} labelOf={(k) => `${k} · ${tenantName(k) ?? (k === "platform" ? "platform (network mgmt)" : "")}`} max={10} />
        </Panel>
      )}
    </div>
  );
}
