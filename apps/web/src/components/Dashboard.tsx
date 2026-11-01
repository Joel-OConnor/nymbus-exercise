"use client";

import { useMemo, useState } from "react";
import type { MetaResponse, Scope } from "@nymbus/shared";
import { api, type Filters, type RangeKey } from "@/lib/api";
import { usePoll } from "@/lib/usePoll";
import { TopBar } from "./TopBar";
import { FilterBar } from "./FilterBar";
import { KpiTiles } from "./KpiTiles";
import { LiveStrip } from "./LiveStrip";
import { TrafficChart, type EventWindow } from "./TrafficChart";
import { LatencyChart } from "./LatencyChart";
import { Breakdowns } from "./Breakdowns";
import { EventsTable } from "./EventsTable";
import { SimPanel } from "./SimPanel";

const GLOBAL: Scope = { role: "global" };

export function Dashboard() {
  const [scope, setScope] = useState<Scope>(GLOBAL);
  const [range, setRange] = useState<RangeKey>("1h");
  const [filters, setFilters] = useState<Filters>({});
  const [eventWindow, setEventWindow] = useState<EventWindow>();

  // Changing identity resets what the previous identity was looking at.
  const scopeKey = `${scope.role}:${scope.tenantId ?? ""}`;
  const [prevScopeKey, setPrevScopeKey] = useState(scopeKey);
  if (prevScopeKey !== scopeKey) {
    setPrevScopeKey(scopeKey);
    setFilters({});
    setEventWindow(undefined);
  }

  // The tenant directory for the identity switcher is a demo affordance; a real
  // console knows who you are. Everything else below is fetched as the chosen identity.
  const { data: directory } = usePoll<MetaResponse>(() => api.meta(GLOBAL), 60_000, []);
  const { data: meta } = usePoll<MetaResponse>(() => api.meta(scope), 30_000, [scopeKey]);

  const filterKey = JSON.stringify(filters);
  const { data: overview, error: overviewError } = usePoll(() => api.overview(scope, range, filters), 3000, [scopeKey, range, filterKey]);
  const { data: series } = usePoll(() => api.timeseries(scope, range, filters), 3000, [scopeKey, range, filterKey]);
  const { data: live } = usePoll(() => api.live(scope, filters), 2000, [scopeKey, filters.tenantId, filters.vendor]);
  const { data: freshness } = usePoll(() => api.freshness(scope), 3000, [scopeKey]);
  const { data: events } = usePoll(() => api.events(scope, filters, eventWindow ?? {}), eventWindow ? 10_000 : 5000, [scopeKey, filterKey, eventWindow?.from, eventWindow?.to]);

  const scopeLabel = useMemo(() => {
    const tenant = scope.role === "tenant" ? scope.tenantId : filters.tenantId;
    if (tenant) return `tenant ${tenant}`;
    if (filters.vendor) return `vendor ${filters.vendor}`;
    return "all traffic";
  }, [scope, filters.tenantId, filters.vendor]);

  return (
    <main className="min-h-screen pb-6">
      <TopBar scope={scope} onScope={setScope} tenants={directory?.tenants ?? []} range={range} onRange={setRange} freshness={freshness} error={overviewError} />
      <FilterBar scope={scope} meta={meta} filters={filters} onChange={setFilters} />
      <div className="space-y-3">
        <KpiTiles overview={overview} live={live} range={range} />
        <LiveStrip live={live} scopeLabel={scopeLabel} />
        <div className="grid grid-cols-1 gap-2 px-4 xl:grid-cols-2">
          <TrafficChart series={series} selected={eventWindow} onSelect={setEventWindow} />
          <LatencyChart series={series} />
        </div>
        <Breakdowns scope={scope} overview={overview} meta={meta} filters={filters} onFilters={setFilters} />
        <EventsTable events={events} meta={meta} window={eventWindow} onClearWindow={() => setEventWindow(undefined)} />
        <SimPanel scope={scope} meta={directory} />
      </div>
    </main>
  );
}
