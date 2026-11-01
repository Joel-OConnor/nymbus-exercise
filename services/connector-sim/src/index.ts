import { Kafka, logLevel } from "kafkajs";
import { createPool, runMigrations } from "@nymbus/db";
import { MetricsEmitter, ensureTopic, quietKafkaJsTimeoutWarning } from "@nymbus/metrics-emitter";
quietKafkaJsTimeoutWarning();
import { initMetrics } from "@nymbus/otel";
import { VENDORS, type Vendor } from "@nymbus/shared";
import { config } from "./config";
import { Connector } from "./connector";
import { startControlServer } from "./control";
import { poisson } from "./random";
import { ScenarioManager } from "./scenarios";
import { buildTenants } from "./tenants";
import { generateNetworkMessage, generateTransaction } from "./traffic";

const log = (msg: string) => console.log(`[sim] ${new Date().toISOString()} ${msg}`);
const startedAt = new Date();

// --- tenant population -------------------------------------------------------
const tenants = buildTenants(config.tenantCount, config.tpsScale);
const totalTps = tenants.reduce((s, t) => s + t.baseTps, 0);
log(`${tenants.length} tenants across ${Object.keys(VENDORS).length} vendors, steady-state ~${totalTps.toFixed(0)} tps`);

// --- register tenants (in the platform this table already exists) -------------
const pool = createPool(config.databaseUrl, { max: 2 });
await runMigrations(pool, log);
for (const t of tenants) {
  await pool.query(
    `INSERT INTO tenant (tenant_id, name, vendor) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id) DO UPDATE SET name = EXCLUDED.name, vendor = EXCLUDED.vendor`,
    [t.tenantId, t.name, t.vendor],
  );
}
await pool.end();

// --- Kafka topic + emitter ----------------------------------------------------
const kafka = new Kafka({ clientId: "connector-sim-admin", brokers: config.brokers, logLevel: logLevel.NOTHING });
try {
  const created = await ensureTopic(kafka, config.topic, config.topicPartitions);
  log(created ? `created topic ${config.topic} (${config.topicPartitions} partitions)` : `topic ${config.topic} exists`);
} catch (err) {
  log(`could not ensure topic (continuing; emitter will retry): ${(err as Error).message}`);
}

const emitter = new MetricsEmitter({ brokers: config.brokers, topic: config.topic, clientId: "connector-sim", log });
emitter.start();
const connector = new Connector(emitter);
const scenarios = new ScenarioManager();

// --- OTel: the connector's own health signals go to the long-term stack -------
const otel = initMetrics("connector-sim");
const emittedCounter = otel.meter.createObservableCounter("metrics_emitter_emitted", { description: "Events handed to the emitter" });
const droppedCounter = otel.meter.createObservableCounter("metrics_emitter_dropped", { description: "Events dropped (buffer full or send failed)" });
const bufferGauge = otel.meter.createObservableGauge("metrics_emitter_buffer_size");
const overheadGauge = otel.meter.createObservableGauge("connector_emit_overhead_p99_ms");
otel.meter.addBatchObservableCallback(
  (res) => {
    const s = emitter.getStats();
    res.observe(emittedCounter, s.emitted);
    res.observe(droppedCounter, s.dropped);
    res.observe(bufferGauge, s.bufferSize);
    res.observe(overheadGauge, connector.stats().emitOverheadMs.p99);
  },
  [emittedCounter, droppedCounter, bufferGauge, overheadGauge],
);

// --- traffic loop -------------------------------------------------------------
const tickSec = config.tickMs / 1000;
let lastHeartbeat = 0;
const loop = setInterval(() => {
  const now = new Date();
  scenarios.expire(now);
  for (const t of tenants) {
    const fx = scenarios.effectsFor(t.tenantId, t.vendor);
    if (fx.outage) continue;
    const n = poisson(t.baseTps * fx.tpsMultiplier * tickSec);
    for (let i = 0; i < n; i++) connector.complete(generateTransaction(t, fx, now));
  }
  // one 0800 echo per vendor connection every ~5 s
  if (now.getTime() - lastHeartbeat >= 5_000) {
    lastHeartbeat = now.getTime();
    for (const v of Object.keys(VENDORS) as Vendor[]) connector.complete(generateNetworkMessage(v, now));
  }
}, config.tickMs);

const statusTimer = setInterval(() => {
  const c = connector.stats();
  const e = emitter.getStats();
  log(`tps=${c.currentTps} emitted=${e.emitted} sent=${e.sent} dropped=${e.dropped} buffer=${e.bufferSize} kafka=${e.connected ? "up" : "DOWN"} emit_p99=${c.emitOverheadMs.p99}ms scenarios=${scenarios.list().length}`);
}, 10_000);

const control = await startControlServer({ port: config.controlPort, tenants, scenarios, connector, emitter, startedAt });
log(`control API on :${config.controlPort}`);

async function shutdown() {
  clearInterval(loop);
  clearInterval(statusTimer);
  await control.close();
  await emitter.stop();
  await otel.shutdown();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
