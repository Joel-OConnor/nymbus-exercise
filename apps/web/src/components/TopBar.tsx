"use client";

import type { FreshnessResponse, Scope, TenantInfo } from "@nymbus/shared";
import { RANGES, type RangeKey } from "@/lib/api";

export function TopBar({
  scope,
  onScope,
  tenants,
  range,
  onRange,
  freshness,
  error,
}: {
  scope: Scope;
  onScope: (s: Scope) => void;
  tenants: TenantInfo[];
  range: RangeKey;
  onRange: (r: RangeKey) => void;
  freshness?: FreshnessResponse;
  error?: string;
}) {
  const lag = freshness?.lagSeconds;
  const lagColor = lag == null ? "bg-slate-500" : lag < 5 ? "bg-emerald-400" : lag < 15 ? "bg-amber-400" : "bg-rose-500";
  const lagText = lag == null ? "no aggregator heartbeat" : `${lag.toFixed(1)}s behind live`;

  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5">
      <div className="mr-auto">
        <div className="text-[11px] uppercase tracking-wider text-muted">Operations console</div>
        <h1 className="text-base font-semibold leading-tight">Real-time traffic</h1>
      </div>

      <div className="flex items-center gap-2 text-xs text-muted">
        <span className={`inline-block h-2 w-2 rounded-full ${lagColor}`} />
        <span>{lagText}</span>
        {freshness && freshness.aggregators.length > 0 && <span className="text-slate-500">· {freshness.aggregators.length} aggregator{freshness.aggregators.length > 1 ? "s" : ""}</span>}
        {error && <span className="text-rose-400">· {error}</span>}
      </div>

      <div className="seg">
        {RANGES.map((r) => (
          <button key={r.key} data-active={r.key === range} onClick={() => onRange(r.key)}>
            {r.label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <div className="seg">
          <button data-active={scope.role === "global"} onClick={() => onScope({ role: "global" })}>
            Platform operator
          </button>
          <button data-active={scope.role === "tenant"} onClick={() => onScope({ role: "tenant", tenantId: scope.tenantId ?? tenants[0]?.tenantId ?? "t001" })}>
            Tenant admin
          </button>
        </div>
        {scope.role === "tenant" && (
          <select className="control" value={scope.tenantId} onChange={(e) => onScope({ role: "tenant", tenantId: e.target.value })}>
            {tenants.map((t) => (
              <option key={t.tenantId} value={t.tenantId}>
                {t.tenantId} · {t.name}
              </option>
            ))}
          </select>
        )}
      </div>
    </header>
  );
}
