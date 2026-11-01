import type { OutcomeClass } from "./iso8583";

/** Who is asking. In production this comes from the console's session; here it is two headers. */
export type Role = "global" | "tenant";
export interface Scope {
  role: Role;
  /** Required when role === "tenant". */
  tenantId?: string;
}

export interface DimensionFilters {
  tenantId?: string;
  vendor?: string;
  msgType?: string;
  txnFamily?: string;
  outcomeCode?: string;
  outcomeClass?: OutcomeClass;
}

export interface TimeRange {
  from: string;
  to: string;
}

export interface TenantInfo {
  tenantId: string;
  name: string;
  vendor: string;
}

export interface MetaResponse {
  tenants: TenantInfo[];
  vendors: { key: string; label: string }[];
  msgTypes: { key: string; label: string }[];
  txnFamilies: { key: string; label: string }[];
  outcomeCodes: { key: string; label: string; class: OutcomeClass }[];
}

export interface Totals {
  count: number;
  approved: number;
  softDeclines: number;
  hardDeclines: number;
  systemErrors: number;
  formatErrors: number;
  amountSum: number;
  latencyAvgMs: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyMaxMs: number;
}

export interface BreakdownRow {
  key: string;
  count: number;
  approved: number;
  latencyP95Ms: number;
}

export interface OverviewResponse {
  range: TimeRange;
  totals: Totals;
  breakdowns: {
    outcomeCode: BreakdownRow[];
    txnFamily: BreakdownRow[];
    msgType: BreakdownRow[];
    vendor: BreakdownRow[];
    tenant: BreakdownRow[];
  };
}

export interface TimeseriesPoint {
  ts: string;
  count: number;
  approved: number;
  softDeclines: number;
  hardDeclines: number;
  systemErrors: number;
  formatErrors: number;
  amountSum: number;
  latencyAvgMs: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyMaxMs: number;
}

export interface TimeseriesResponse {
  range: TimeRange;
  stepSeconds: number;
  source: "rollup_1m" | "rollup_5m";
  points: TimeseriesPoint[];
}

export interface LivePoint {
  ts: string;
  count: number;
  approved: number;
  declined: number;
  errors: number;
  latencyAvgMs: number;
  latencyP95Ms: number;
}

export interface LiveResponse {
  scope: string;
  binSeconds: number;
  points: LivePoint[];
}

export interface EventRow {
  eventId: string;
  occurredAt: string;
  tenantId: string;
  vendor: string;
  sourceConn: string;
  msgType: string;
  txnFamily: string;
  outcomeCode: string;
  amount: number;
  latencyMs: number;
  stan: string;
  bin: string;
}

export interface EventsResponse {
  range: TimeRange;
  events: EventRow[];
  truncated: boolean;
}

export interface FreshnessResponse {
  /** Seconds between now and the newest event the aggregator has written. */
  lagSeconds: number | null;
  lastEventAt: string | null;
  aggregators: { instance: string; lastEventAt: string; flushedAt: string; processed: number }[];
}

export interface HealthResponse {
  status: "ok";
  service: string;
  timestamp: string;
}
