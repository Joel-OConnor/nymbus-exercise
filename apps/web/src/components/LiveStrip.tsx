"use client";

import { Area, AreaChart, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { LiveResponse } from "@nymbus/shared";
import { Panel } from "./Panel";
import { fmtClock, fmtMs, LATENCY_BUDGET_MS } from "@/lib/format";

export function LiveStrip({ live, scopeLabel }: { live?: LiveResponse; scopeLabel: string }) {
  const data = (live?.points ?? []).map((p) => ({ ...p, t: fmtClock(p.ts), tps: live ? p.count / live.binSeconds : 0 }));
  return (
    <div className="grid grid-cols-1 gap-2 px-4 md:grid-cols-2">
      <Panel title="Live throughput" right={`${scopeLabel} · last 5 min · ${live?.binSeconds ?? 5}s bins · Valkey`}>
        <div className="h-24">
          <ResponsiveContainer>
            <AreaChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="tpsFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#60a5fa" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="#60a5fa" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <XAxis dataKey="t" tick={{ fontSize: 10, fill: "#8b9bb4" }} interval="preserveStartEnd" minTickGap={40} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: "#8b9bb4" }} axisLine={false} tickLine={false} width={48} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => [`${Number(v).toFixed(1)} tps`, "throughput"]} labelStyle={{ color: "#8b9bb4" }} />
              <Area type="monotone" dataKey="tps" stroke="#60a5fa" fill="url(#tpsFill)" strokeWidth={1.5} isAnimationActive={false} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Panel>
      <Panel title="Live p95 latency" right={`budget ${LATENCY_BUDGET_MS} ms`}>
        <div className="h-24">
          <ResponsiveContainer>
            <LineChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
              <XAxis dataKey="t" tick={{ fontSize: 10, fill: "#8b9bb4" }} interval="preserveStartEnd" minTickGap={40} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: "#8b9bb4" }} axisLine={false} tickLine={false} width={48} domain={[0, (max: number) => Math.max(600, Math.ceil(max / 100) * 100)]} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => [fmtMs(Number(v)), "p95"]} labelStyle={{ color: "#8b9bb4" }} />
              <ReferenceLine y={LATENCY_BUDGET_MS} stroke="#ef4444" strokeDasharray="4 4" />
              <Line type="monotone" dataKey="latencyP95Ms" stroke="#f59e0b" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Panel>
    </div>
  );
}

export const tooltipStyle = { background: "#111a2e", border: "1px solid #22304d", borderRadius: 6, fontSize: 12 };
