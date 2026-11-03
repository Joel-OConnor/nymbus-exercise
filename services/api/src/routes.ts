import type { FastifyInstance } from "fastify";
import type Redis from "ioredis";
import { listPartitions, type Pool } from "@nymbus/db";
import {
  MESSAGE_TYPES,
  OUTCOME_CODES,
  TXN_FAMILIES,
  VENDORS,
  type DimensionFilters,
  type FreshnessResponse,
  type MetaResponse,
  type OutcomeClass,
} from "@nymbus/shared";
import { TtlCache } from "./cache";
import { config } from "./config";
import { intParam } from "./params";
import { summarizeFreshness } from "./freshness";
import { readLive } from "./live";
import { events, overview, timeseries, type Window } from "./queries";
import { resolveScope, withScope } from "./scope";

type Q = Record<string, string | undefined>;

const RANGE_SECONDS: Record<string, number> = { "5m": 300, "15m": 900, "1h": 3600, "6h": 6 * 3600, "24h": 24 * 3600 };

function parseWindow(q: Q, defaultRange = "1h", maxSeconds = 24 * 3600): Window {
  const to = q.to ? new Date(q.to) : new Date();
  let from: Date;
  if (q.from) from = new Date(q.from);
  else from = new Date(to.getTime() - (RANGE_SECONDS[q.range ?? defaultRange] ?? RANGE_SECONDS[defaultRange]) * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw Object.assign(new Error("invalid time range"), { statusCode: 400 });
  if (to.getTime() - from.getTime() > maxSeconds * 1000) from = new Date(to.getTime() - maxSeconds * 1000);
  return { from, to };
}

const DIM_KEYS: (keyof DimensionFilters)[] = ["tenantId", "vendor", "msgType", "txnFamily", "outcomeCode", "outcomeClass"];
function parseFilters(q: Q): DimensionFilters {
  const f: DimensionFilters = {};
  for (const k of DIM_KEYS) {
    const v = q[k];
    if (v && /^[a-z0-9_:-]{1,64}$/i.test(v)) (f as Record<string, string>)[k] = v;
  }
  if (f.outcomeClass && !["approved", "soft_decline", "hard_decline", "system_error", "format_error"].includes(f.outcomeClass)) delete f.outcomeClass;
  return f;
}

export function registerRoutes(app: FastifyInstance, pool: Pool, redis: Redis) {
  const cache = new TtlCache<unknown>(config.cacheTtlMs);

  app.get("/health", async () => ({ status: "ok", service: "dashboard-api", timestamp: new Date().toISOString() }));

  app.register(async (scoped) => {
    scoped.addHook("preHandler", resolveScope);

    scoped.get("/api/me", async (req) => req.scope);

    scoped.get("/api/meta", async (req): Promise<MetaResponse> => {
      const tenants = await withScope(pool, req.scope, async (c) => (await c.query("SELECT tenant_id, name, vendor FROM tenant ORDER BY tenant_id")).rows);
      return {
        tenants: tenants.map((t) => ({ tenantId: t.tenant_id, name: t.name, vendor: t.vendor })),
        vendors: Object.entries(VENDORS).map(([key, v]) => ({ key, label: v.label })),
        msgTypes: Object.entries(MESSAGE_TYPES).map(([key, v]) => ({ key, label: v.label })),
        txnFamilies: Object.entries(TXN_FAMILIES).map(([key, v]) => ({ key, label: v.label })),
        outcomeCodes: Object.entries(OUTCOME_CODES).map(([key, v]) => ({ key, label: v.label, class: v.class as OutcomeClass })),
      };
    });

    scoped.get<{ Querystring: Q }>("/api/overview", async (req) => {
      const w = parseWindow(req.query);
      const f = parseFilters(req.query);
      // Round "now" to the second so concurrent pollers share a cache key.
      const key = `ov|${req.scope.role}|${req.scope.tenantId ?? ""}|${JSON.stringify(f)}|${Math.floor(w.from.getTime() / 1000)}|${Math.floor(w.to.getTime() / 1000)}`;
      return cache.get(key, () => withScope(pool, req.scope, (c) => overview(c, req.scope, f, w)));
    });

    scoped.get<{ Querystring: Q }>("/api/timeseries", async (req) => {
      const w = parseWindow(req.query);
      const f = parseFilters(req.query);
      const step = req.query.step ? intParam(req.query.step, 60, 60, 24 * 3600) : undefined;
      const key = `ts|${req.scope.role}|${req.scope.tenantId ?? ""}|${JSON.stringify(f)}|${step ?? ""}|${Math.floor(w.from.getTime() / 1000)}|${Math.floor(w.to.getTime() / 1000)}`;
      return cache.get(key, () => withScope(pool, req.scope, (c) => timeseries(c, req.scope, f, w, step)));
    });

    scoped.get<{ Querystring: Q }>("/api/events", async (req) => {
      const w = parseWindow(req.query, "15m", 75 * 60);
      const f = parseFilters(req.query);
      const limit = intParam(req.query.limit, 100, 1, 500);
      const r = await withScope(pool, req.scope, (c) => events(c, req.scope, f, w, limit));
      return { range: { from: w.from.toISOString(), to: w.to.toISOString() }, ...r };
    });

    scoped.get<{ Querystring: Q }>("/api/live", async (req) => {
      const seconds = intParam(req.query.seconds, 300, 10, 900);
      const bin = intParam(req.query.bin, 5, 1, 60);
      const f = parseFilters(req.query);
      const tenant = req.scope.role === "tenant" ? req.scope.tenantId : f.tenantId;
      const scope = tenant ? `t:${tenant}` : f.vendor ? `v:${f.vendor}` : "all";
      return readLive(redis, scope, seconds, bin);
    });

    scoped.get("/api/freshness", async (): Promise<FreshnessResponse> => summarizeFreshness(await redis.hgetall("metrics:aggregators")));

    scoped.get("/api/admin/partitions", async (req, reply) => {
      if (req.scope.role !== "global") return reply.code(403).send({ error: "global operators only" });
      return listPartitions(pool);
    });

    // Demo-only: proxy the traffic simulator's control surface so the browser talks to one origin.
    scoped.all<{ Params: { "*": string }; Body: unknown }>("/api/sim/*", async (req, reply) => {
      const url = `${config.simControlUrl}/${req.params["*"]}`;
      let body: unknown = req.body ?? {};
      if (req.scope.role === "tenant") {
        // A tenant admin may create conditions only for their own institution, and may not clear everyone's.
        if (req.method === "POST") body = { ...(body as Record<string, unknown>), tenantId: req.scope.tenantId, vendor: undefined };
        if (req.method === "DELETE" && req.params["*"] === "scenarios") return reply.code(403).send({ error: "global operators only" });
        if (req.params["*"] === "tenants") return reply.code(403).send({ error: "global operators only" });
      }
      try {
        const res = await fetch(url, {
          method: req.method,
          headers: { "content-type": "application/json" },
          body: req.method === "GET" || req.method === "HEAD" ? undefined : JSON.stringify(body),
        });
        reply.code(res.status);
        return res.headers.get("content-type")?.includes("json") ? res.json() : res.text();
      } catch (err) {
        return reply.code(502).send({ error: `simulator unreachable: ${(err as Error).message}` });
      }
    });
  });
}
