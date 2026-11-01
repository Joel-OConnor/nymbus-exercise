"use client";

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TimeseriesResponse } from "@nymbus/shared";
import { Panel } from "./Panel";
import { tooltipStyle } from "./LiveStrip";
import { fmtCompact, fmtTime, OUTCOME_CLASS_COLORS, OUTCOME_CLASS_LABELS } from "@/lib/format";

export interface EventWindow {
  from: string;
  to: string;
}

export function TrafficChart({ series, selected, onSelect }: { series?: TimeseriesResponse; selected?: EventWindow; onSelect: (w: EventWindow | undefined) => void }) {
  const data = (series?.points ?? []).map((p) => ({ ...p, t: fmtTime(p.ts) }));
  const step = series?.stepSeconds ?? 60;
  return (
    <Panel
      title="Transactions by outcome"
      right={
        <span>
          {series ? `${series.source === "rollup_1m" ? "1-minute" : "5-minute"} rollups · ${step >= 60 ? `${step / 60} min` : `${step}s`} buckets · Postgres` : ""}
          {selected && (
            <button className="ml-2 text-accent hover:underline" onClick={() => onSelect(undefined)}>
              clear selection
            </button>
          )}
          {!selected && <span className="ml-2 text-slate-500">click a bar to see its transactions</span>}
        </span>
      }
    >
      <div className="h-56">
        <ResponsiveContainer>
          <BarChart
            data={data}
            margin={{ top: 4, right: 8, left: -12, bottom: 0 }}
            onClick={(state) => {
              const p = (state as { activePayload?: { payload?: { ts: string } }[] } | null)?.activePayload?.[0]?.payload;
              if (!p?.ts) return;
              const from = p.ts;
              const to = new Date(Date.parse(p.ts) + step * 1000).toISOString();
              onSelect(selected?.from === from ? undefined : { from, to });
            }}
            style={{ cursor: "pointer" }}
          >
            <CartesianGrid vertical={false} stroke="#1c2740" />
            <XAxis dataKey="t" tick={{ fontSize: 10, fill: "#8b9bb4" }} minTickGap={32} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 10, fill: "#8b9bb4" }} tickFormatter={(v) => fmtCompact(Number(v))} axisLine={false} tickLine={false} width={56} />
            <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: "#8b9bb4" }} cursor={{ fill: "#ffffff10" }} formatter={(v, name) => [fmtCompact(Number(v)), String(name)]} />
            <Legend wrapperStyle={{ fontSize: 11 }} iconSize={8} />
            <Bar dataKey="approved" name={OUTCOME_CLASS_LABELS.approved} stackId="a" fill={OUTCOME_CLASS_COLORS.approved} isAnimationActive={false} />
            <Bar dataKey="softDeclines" name={OUTCOME_CLASS_LABELS.soft_decline} stackId="a" fill={OUTCOME_CLASS_COLORS.soft_decline} isAnimationActive={false} />
            <Bar dataKey="hardDeclines" name={OUTCOME_CLASS_LABELS.hard_decline} stackId="a" fill={OUTCOME_CLASS_COLORS.hard_decline} isAnimationActive={false} />
            <Bar dataKey="systemErrors" name={OUTCOME_CLASS_LABELS.system_error} stackId="a" fill={OUTCOME_CLASS_COLORS.system_error} isAnimationActive={false} />
            <Bar dataKey="formatErrors" name={OUTCOME_CLASS_LABELS.format_error} stackId="a" fill={OUTCOME_CLASS_COLORS.format_error} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}
