"use client";

import type { MetaResponse, Scope } from "@nymbus/shared";
import type { Filters } from "@/lib/api";
import { OUTCOME_CLASS_LABELS } from "@/lib/format";

const LABELS: Record<keyof Filters, string> = {
  tenantId: "Tenant",
  vendor: "Vendor",
  msgType: "Message type",
  txnFamily: "Family",
  outcomeCode: "Outcome",
  outcomeClass: "Outcome class",
};

export function FilterBar({ scope, meta, filters, onChange }: { scope: Scope; meta?: MetaResponse; filters: Filters; onChange: (f: Filters) => void }) {
  const set = (k: keyof Filters, v: string) => {
    const next = { ...filters, [k]: v || undefined };
    if (k === "outcomeCode" && v) delete next.outcomeClass;
    if (k === "outcomeClass" && v) delete next.outcomeCode;
    onChange(next);
  };
  const active = Object.entries(filters).filter(([, v]) => v) as [keyof Filters, string][];
  const outcomeValue = filters.outcomeCode ? `code:${filters.outcomeCode}` : filters.outcomeClass ? `class:${filters.outcomeClass}` : "";

  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2">
      <span className="text-xs text-muted">Filter</span>
      {scope.role === "global" && (
        <select className="control" value={filters.tenantId ?? ""} onChange={(e) => set("tenantId", e.target.value)}>
          <option value="">All tenants</option>
          {meta?.tenants.map((t) => (
            <option key={t.tenantId} value={t.tenantId}>
              {t.tenantId} · {t.name}
            </option>
          ))}
        </select>
      )}
      <select className="control" value={filters.vendor ?? ""} onChange={(e) => set("vendor", e.target.value)}>
        <option value="">All vendors</option>
        {meta?.vendors.map((v) => (
          <option key={v.key} value={v.key}>
            {v.label}
          </option>
        ))}
      </select>
      <select className="control" value={filters.msgType ?? ""} onChange={(e) => set("msgType", e.target.value)}>
        <option value="">All message types</option>
        {meta?.msgTypes.map((m) => (
          <option key={m.key} value={m.key}>
            {m.key} · {m.label}
          </option>
        ))}
      </select>
      <select className="control" value={filters.txnFamily ?? ""} onChange={(e) => set("txnFamily", e.target.value)}>
        <option value="">All families</option>
        {meta?.txnFamilies.map((f) => (
          <option key={f.key} value={f.key}>
            {f.label}
          </option>
        ))}
      </select>
      <select
        className="control"
        value={outcomeValue}
        onChange={(e) => {
          const [kind, val] = e.target.value.split(":");
          if (!kind) onChange({ ...filters, outcomeCode: undefined, outcomeClass: undefined });
          else if (kind === "class") set("outcomeClass", val);
          else set("outcomeCode", val);
        }}
      >
        <option value="">All outcomes</option>
        <optgroup label="By class">
          {Object.entries(OUTCOME_CLASS_LABELS).map(([k, l]) => (
            <option key={k} value={`class:${k}`}>
              {l}
            </option>
          ))}
        </optgroup>
        <optgroup label="By response code">
          {meta?.outcomeCodes.map((o) => (
            <option key={o.key} value={`code:${o.key}`}>
              {o.key} · {o.label}
            </option>
          ))}
        </optgroup>
      </select>

      {active.length > 0 && (
        <div className="ml-2 flex flex-wrap items-center gap-1.5">
          {active.map(([k, v]) => (
            <span key={k} className="chip">
              <span className="text-muted">{LABELS[k]}:</span> {v}
              <button className="ml-0.5 text-muted hover:text-white" onClick={() => set(k, "")} aria-label={`clear ${LABELS[k]}`}>
                ×
              </button>
            </span>
          ))}
          <button className="text-xs text-muted hover:text-white" onClick={() => onChange({})}>
            clear all
          </button>
        </div>
      )}
    </div>
  );
}
