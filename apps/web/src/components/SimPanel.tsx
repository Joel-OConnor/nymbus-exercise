"use client";

import { useEffect, useState } from "react";
import type { MetaResponse, Scope } from "@nymbus/shared";
import { api, type Scenario, type ScenarioRequest, type SimPreset, type SimStatus } from "@/lib/api";
import { usePoll } from "@/lib/usePoll";
import { fmtCompact } from "@/lib/format";
import { Panel } from "./Panel";

/**
 * Demo-only control surface for the traffic simulator. In the real platform
 * none of this exists; it is here so a presenter can create conditions live and
 * watch the dashboard react.
 */
export function SimPanel({ scope, meta }: { scope: Scope; meta?: MetaResponse }) {
  const [open, setOpen] = useState(true);
  const { data: status, error } = usePoll<SimStatus>(() => api.simStatus(scope), 2000, [scope.role, scope.tenantId]);
  const [presets, setPresets] = useState<SimPreset[]>([]);
  const [type, setType] = useState("latency_spike");
  const [targetKind, setTargetKind] = useState<"none" | "tenant" | "vendor">("tenant");
  const [tenantId, setTenantId] = useState("t001");
  const [vendor, setVendor] = useState("atlas");
  const [magnitude, setMagnitude] = useState<string>("4");
  const [durationSec, setDurationSec] = useState<string>("120");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const [now, setNow] = useState(0);

  useEffect(() => {
    api.simPresets(scope).then(setPresets).catch(() => {});
  }, [scope]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  // A tenant admin can only target their own institution.
  const lockedToTenant = scope.role === "tenant" && !!scope.tenantId;
  const effTargetKind = lockedToTenant ? "tenant" : targetKind;
  const effTenantId = lockedToTenant ? scope.tenantId! : tenantId;

  const preset = presets.find((p) => p.type === type);
  const pickType = (t: string) => {
    setType(t);
    const p = presets.find((x) => x.type === t);
    if (p) {
      setMagnitude(String(p.magnitude));
      setDurationSec(String(p.durationSec));
    }
    if (t === "outage" && effTargetKind === "none") setTargetKind("tenant");
  };

  const inject = async (override?: ScenarioRequest) => {
    setBusy(true);
    setMsg(undefined);
    try {
      const body = override ?? {
        type,
        tenantId: effTargetKind === "tenant" ? effTenantId : undefined,
        vendor: effTargetKind === "vendor" ? vendor : undefined,
        magnitude: Number(magnitude),
        durationSec: Number(durationSec),
      };
      const s = await api.simInject(scope, body);
      setMsg(`started: ${s.description}`);
    } catch (err) {
      setMsg(`error: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id?: string) => {
    setMsg(undefined);
    try {
      await (id ? api.simCancel(scope, id) : api.simCancelAll(scope));
      setMsg(id ? `cancelled scenario ${id}` : "cancelled all scenarios");
    } catch (err) {
      setMsg(`error: ${(err as Error).message}`);
    }
  };

  const e = status?.emitter;
  const c = status?.connector;
  const tenants = meta?.tenants ?? [];
  const largest = "t001";

  return (
    <div className="px-4 pb-4">
      <Panel
        title={
          <span>
            Traffic simulator <span className="ml-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">demo only</span>
          </span>
        }
        right={
          <span className="flex items-center gap-3">
            {status && (
              <>
                <span>
                  {status.tenantCount} tenants · {status.vendors.length} vendors · <b className="text-slate-200">{c?.currentTps.toFixed(0)} tps</b> (target {status.targetTps.toFixed(0)})
                </span>
                <span>
                  emitter: {e?.connected ? <span className="text-emerald-300">Kafka up</span> : <span className="text-rose-400">Kafka DOWN</span>} · buffer {e?.bufferSize} · sent {fmtCompact(e?.sent ?? 0)} ·{" "}
                  <span className={e?.dropped ? "text-rose-400" : ""}>dropped {fmtCompact(e?.dropped ?? 0)}</span>
                </span>
                <span title="Time the connector spends in emitter.emit() per transaction">
                  hot-path cost p99 <b className="text-emerald-300">{c?.emitOverheadMs.p99} ms</b> (max {c?.emitOverheadMs.max} ms)
                </span>
              </>
            )}
            {error && <span className="text-rose-400">simulator unreachable</span>}
            <button className="btn" onClick={() => setOpen((o) => !o)}>
              {open ? "hide" : "show"}
            </button>
          </span>
        }
      >
        {open && (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1.2fr_1fr]">
            <div>
              <div className="mb-2 flex flex-wrap gap-1.5">
                <span className="self-center text-xs text-muted">Quick:</span>
                <button className="btn" disabled={busy} onClick={() => inject({ type: "latency_spike", tenantId: largest, magnitude: 4, durationSec: 120 })}>
                  Latency spike · {largest}
                </button>
                <button className="btn" disabled={busy} onClick={() => inject({ type: "decline_spike", vendor: "atlas", magnitude: 0.35, durationSec: 120 })}>
                  Decline spike · Atlas Pay
                </button>
                <button className="btn" disabled={busy} onClick={() => inject({ type: "system_errors", tenantId: "t017", magnitude: 0.3, durationSec: 120 })}>
                  Issuer errors · t017
                </button>
                <button className="btn" disabled={busy} onClick={() => inject({ type: "outage", vendor: "summit", durationSec: 90 })}>
                  Outage · Summit EFT
                </button>
                <button className="btn" disabled={busy} onClick={() => inject({ type: "traffic_surge", magnitude: 3, durationSec: 120 })}>
                  3× surge · platform-wide
                </button>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-xs text-muted">
                  Scenario
                  <select className="control mt-0.5 block" value={type} onChange={(ev) => pickType(ev.target.value)}>
                    {presets.map((p) => (
                      <option key={p.type} value={p.type}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-muted">
                  Target
                  <select className="control mt-0.5 block" value={effTargetKind} onChange={(ev) => setTargetKind(ev.target.value as "none" | "tenant" | "vendor")} disabled={lockedToTenant}>
                    <option value="none">Platform-wide</option>
                    <option value="tenant">Tenant</option>
                    <option value="vendor">Vendor</option>
                  </select>
                </label>
                {effTargetKind === "tenant" && (
                  <select className="control" value={effTenantId} onChange={(ev) => setTenantId(ev.target.value)} disabled={lockedToTenant}>
                    {tenants.map((t) => (
                      <option key={t.tenantId} value={t.tenantId}>
                        {t.tenantId} · {t.name}
                      </option>
                    ))}
                  </select>
                )}
                {effTargetKind === "vendor" && (
                  <select className="control" value={vendor} onChange={(ev) => setVendor(ev.target.value)}>
                    {(meta?.vendors ?? []).map((v) => (
                      <option key={v.key} value={v.key}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                )}
                {type !== "outage" && (
                  <label className="text-xs text-muted">
                    Magnitude {preset?.unit && <span className="text-slate-500">({preset.unit})</span>}
                    <input className="control mt-0.5 block w-24" type="number" step="any" min="0" value={magnitude} onChange={(ev) => setMagnitude(ev.target.value)} />
                  </label>
                )}
                <label className="text-xs text-muted">
                  Duration (s)
                  <input className="control mt-0.5 block w-20" type="number" min="5" max="3600" value={durationSec} onChange={(ev) => setDurationSec(ev.target.value)} />
                </label>
                <button className="btn-primary" disabled={busy} onClick={() => inject()}>
                  Inject
                </button>
              </div>
              {preset && <p className="mt-2 text-xs text-slate-400">{preset.description}</p>}
              {msg && <p className={`mt-1 text-xs ${msg.startsWith("error") ? "text-rose-400" : "text-emerald-300"}`}>{msg}</p>}
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="panel-title">Active scenarios</span>
                {status?.scenarios.length && scope.role === "global" ? (
                  <button className="text-xs text-muted hover:text-white" onClick={() => void cancel()}>
                    cancel all
                  </button>
                ) : null}
              </div>
              {!status?.scenarios.length && <div className="rounded border border-dashed border-border px-3 py-4 text-center text-xs text-slate-500">none · traffic is at steady state</div>}
              <ul className="space-y-1">
                {status?.scenarios.map((s: Scenario) => {
                  const left = Math.max(0, Math.round((Date.parse(s.endsAt) - now) / 1000));
                  const total = Math.max(1, (Date.parse(s.endsAt) - Date.parse(s.startedAt)) / 1000);
                  return (
                    <li key={s.id} className="rounded border border-border bg-panel-2 px-2 py-1.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-200">{s.description}</span>
                        <span className="flex items-center gap-2 whitespace-nowrap text-slate-400">
                          {left}s left
                          <button className="text-muted hover:text-white" onClick={() => void cancel(s.id)} aria-label="cancel scenario">
                            ×
                          </button>
                        </span>
                      </div>
                      <div className="mt-1 h-1 w-full rounded bg-bg">
                        <div className="h-1 rounded bg-amber-400" style={{ width: `${(100 * left) / total}%` }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
