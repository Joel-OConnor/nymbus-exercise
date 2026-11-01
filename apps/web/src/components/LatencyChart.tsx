"use client";

import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TimeseriesResponse } from "@nymbus/shared";
import { Panel } from "./Panel";
import { tooltipStyle } from "./LiveStrip";
import { fmtMs, fmtTime, LATENCY_BUDGET_MS } from "@/lib/format";

export function LatencyChart({ series }: { series?: TimeseriesResponse }) {
  const data = (series?.points ?? []).map((p) => ({
    t: fmtTime(p.ts),
    p50: p.count ? p.latencyP50Ms : null,
    p95: p.count ? p.latencyP95Ms : null,
    max: p.count ? p.latencyMaxMs : null,
  }));
  return (
    <Panel title="Latency" right={`p50 / p95 estimated from histogram bins · max observed · budget ${LATENCY_BUDGET_MS} ms`}>
      <div className="h-56">
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="#1c2740" />
            <XAxis dataKey="t" tick={{ fontSize: 10, fill: "#8b9bb4" }} minTickGap={32} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 10, fill: "#8b9bb4" }} axisLine={false} tickLine={false} width={56} domain={[0, (max: number) => Math.max(600, Math.ceil(max / 250) * 250)]} />
            <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: "#8b9bb4" }} formatter={(v, name) => [v == null ? "–" : fmtMs(Number(v)), String(name)]} />
            <Legend wrapperStyle={{ fontSize: 11 }} iconSize={8} />
            <ReferenceLine y={LATENCY_BUDGET_MS} stroke="#ef4444" strokeDasharray="4 4" label={{ value: "500 ms budget", fill: "#ef4444", fontSize: 10, position: "insideTopRight" }} />
            <Line type="monotone" dataKey="max" name="max" stroke="#475569" strokeWidth={1} dot={false} isAnimationActive={false} connectNulls={false} />
            <Line type="monotone" dataKey="p95" name="p95" stroke="#f59e0b" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
            <Line type="monotone" dataKey="p50" name="p50" stroke="#2dd4bf" strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}
