import Fastify from "fastify";
import cors from "@fastify/cors";
import { VENDORS } from "@nymbus/shared";
import type { MetricsEmitter } from "@nymbus/metrics-emitter";
import type { Connector } from "./connector";
import { PRESETS, ScenarioManager, type ScenarioRequest } from "./scenarios";
import type { SimTenant } from "./tenants";

/**
 * Demo control surface. Not part of the proposed product; it exists so the
 * presenter can inject conditions live and watch the dashboard react.
 */
export async function startControlServer(opts: {
  port: number;
  tenants: SimTenant[];
  scenarios: ScenarioManager;
  connector: Connector;
  emitter: MetricsEmitter;
  startedAt: Date;
}) {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });

  app.get("/health", async () => ({ status: "ok", service: "connector-sim", timestamp: new Date().toISOString() }));

  app.get("/status", async () => {
    const targetTps = opts.tenants.reduce((s, t) => s + t.baseTps * opts.scenarios.effectsFor(t.tenantId, t.vendor).tpsMultiplier * (opts.scenarios.effectsFor(t.tenantId, t.vendor).outage ? 0 : 1), 0);
    return {
      uptimeSec: Math.round((Date.now() - opts.startedAt.getTime()) / 1000),
      tenantCount: opts.tenants.length,
      vendors: Object.keys(VENDORS),
      targetTps: Math.round(targetTps * 10) / 10,
      connector: opts.connector.stats(),
      emitter: opts.emitter.getStats(),
      scenarios: opts.scenarios.list(),
    };
  });

  app.get("/tenants", async () => opts.tenants.map((t) => ({ tenantId: t.tenantId, name: t.name, vendor: t.vendor, baseTps: Math.round(t.baseTps * 10) / 10 })));

  app.get("/presets", async () => Object.entries(PRESETS).map(([type, p]) => ({ type, ...p })));

  app.get("/scenarios", async () => opts.scenarios.list());

  app.post<{ Body: ScenarioRequest }>("/scenarios", async (req, reply) => {
    try {
      const body = req.body ?? ({} as ScenarioRequest);
      if (body.tenantId && !opts.tenants.some((t) => t.tenantId === body.tenantId)) {
        return reply.code(400).send({ error: `unknown tenant ${body.tenantId}` });
      }
      if (body.vendor && !(body.vendor in VENDORS)) {
        return reply.code(400).send({ error: `unknown vendor ${body.vendor}` });
      }
      return reply.code(201).send(opts.scenarios.add(body));
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete<{ Params: { id: string } }>("/scenarios/:id", async (req, reply) => {
    return opts.scenarios.remove(req.params.id) ? { removed: req.params.id } : reply.code(404).send({ error: "not found" });
  });

  app.delete("/scenarios", async () => {
    opts.scenarios.clear();
    return { removed: "all" };
  });

  await app.listen({ port: opts.port, host: "0.0.0.0" });
  return app;
}
