"use client";

import type { EventsResponse, MetaResponse } from "@nymbus/shared";
import { outcomeClass } from "@nymbus/shared";
import { Panel } from "./Panel";
import type { EventWindow } from "./TrafficChart";
import { fmtClock, fmtTime, LATENCY_BUDGET_MS, OUTCOME_CLASS_COLORS } from "@/lib/format";

export function EventsTable({ events, meta, window, onClearWindow }: { events?: EventsResponse; meta?: MetaResponse; window?: EventWindow; onClearWindow: () => void }) {
  const rows = events?.events ?? [];
  return (
    <div className="px-4">
      <Panel
        title="Transactions"
        right={
          <span>
            {window ? (
              <>
                {fmtTime(window.from)}–{fmtTime(window.to)} ·{" "}
                <button className="text-accent hover:underline" onClick={onClearWindow}>
                  back to last 15 min
                </button>
              </>
            ) : (
              "last 15 min, newest first"
            )}
            {events?.truncated && <span className="ml-2 text-slate-500">· showing first {rows.length} matching</span>}
            <span className="ml-2 text-slate-500">· raw events, 1 h retention · Postgres</span>
          </span>
        }
      >
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-panel text-left text-[11px] uppercase tracking-wider text-muted">
              <tr>
                <th className="py-1 pr-3 font-medium">Time</th>
                <th className="py-1 pr-3 font-medium">Tenant</th>
                <th className="py-1 pr-3 font-medium">Vendor / conn</th>
                <th className="py-1 pr-3 font-medium">MTI</th>
                <th className="py-1 pr-3 font-medium">Family</th>
                <th className="py-1 pr-3 font-medium">Outcome</th>
                <th className="py-1 pr-3 text-right font-medium">Amount</th>
                <th className="py-1 pr-3 text-right font-medium">Latency</th>
                <th className="py-1 pr-3 font-medium">STAN</th>
                <th className="py-1 font-medium">BIN</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {rows.map((e) => {
                const cls = outcomeClass(e.outcomeCode);
                return (
                  <tr key={e.eventId} className="border-t border-border/60 hover:bg-panel-2">
                    <td className="py-1 pr-3 text-slate-400">{fmtClock(e.occurredAt)}</td>
                    <td className="py-1 pr-3">{e.tenantId}</td>
                    <td className="py-1 pr-3 text-slate-300">{e.sourceConn}</td>
                    <td className="py-1 pr-3">{e.msgType}</td>
                    <td className="py-1 pr-3">{e.txnFamily}</td>
                    <td className="py-1 pr-3">
                      <span className="inline-block h-2 w-2 rounded-full align-middle" style={{ background: OUTCOME_CLASS_COLORS[cls] }} /> {e.outcomeCode}{" "}
                      <span className="text-slate-500">{meta?.outcomeCodes.find((o) => o.key === e.outcomeCode)?.label}</span>
                    </td>
                    <td className="py-1 pr-3 text-right">{e.amount ? `$${e.amount.toFixed(2)}` : "–"}</td>
                    <td className={`py-1 pr-3 text-right ${e.latencyMs > LATENCY_BUDGET_MS ? "text-rose-400" : ""}`}>{e.latencyMs} ms</td>
                    <td className="py-1 pr-3 text-slate-400">{e.stan}</td>
                    <td className="py-1 text-slate-400">{e.bin}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={10} className="py-6 text-center text-slate-500">
                    no transactions match
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
