import { Kafka, logLevel, type Consumer } from "kafkajs";
import Redis from "ioredis";
import { createPool, maintainPartitions, runMigrations } from "@nymbus/db";
import { ensureTopic, quietKafkaJsTimeoutWarning } from "@nymbus/metrics-emitter";
quietKafkaJsTimeoutWarning();
import { initMetrics } from "@nymbus/otel";
import { LATENCY_BUCKETS_MS, outcomeClass, type TxnMetricEvent } from "@nymbus/shared";
import { Accumulator } from "./accumulator";
import { config } from "./config";
import { writeEvents, writeHeartbeat, writeLive, writeRollups } from "./writers";

const log = (msg: string) => console.log(`[agg] ${new Date().toISOString()} ${msg}`);

// --- storage -------------------------------------------------------------------
const pool = createPool(config.databaseUrl, { max: 6 });
await runMigrations(pool, log);
const initial = await maintainPartitions(pool);
log(`partitions ready (created ${initial.created.length}, dropped ${initial.dropped.length})`);

const redis = new Redis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 });
redis.on("error", (e) => log(`valkey error: ${e.message}`));

// --- OTel: the >24h leg ---------------------------------------------------------
const otel = initMetrics("metrics-aggregator", { instanceId: config.instanceId });
const txnCounter = otel.meter.createCounter("txn_count", { description: "Transactions processed, by tenant/vendor/type/outcome class" });
const amountCounter = otel.meter.createCounter("txn_amount", { description: "Sum of transaction amounts (major units)" });
const latencyHist = otel.meter.createHistogram("txn_latency_ms", {
  description: "Connector end-to-end latency",
  advice: { explicitBucketBoundaries: [...LATENCY_BUCKETS_MS] },
});
const lagGauge = otel.meter.createObservableGauge("aggregator_lag_seconds", { description: "Now minus newest event written" });
const processedCounter = otel.meter.createCounter("aggregator_events_processed");
const invalidCounter = otel.meter.createCounter("aggregator_invalid_messages");
const flushErrors = otel.meter.createCounter("aggregator_flush_errors");

// --- state -----------------------------------------------------------------------
let acc = new Accumulator();
const pendingOffsets = new Map<number, string>(); // partition -> next offset to commit
let processedTotal = 0;
let newestEventMs = 0;
let paused = false;
let flushing = false;

lagGauge.addCallback((r) => r.observe(newestEventMs ? Math.max(0, (Date.now() - newestEventMs) / 1000) : 0));

// --- Kafka -----------------------------------------------------------------------
const kafka = new Kafka({ clientId: `aggregator-${config.instanceId}`, brokers: config.brokers, logLevel: logLevel.NOTHING, retry: { retries: 8, initialRetryTime: 300, maxRetryTime: 10_000 } });
try {
  await ensureTopic(kafka, config.topic, config.topicPartitions);
} catch (err) {
  log(`ensureTopic: ${(err as Error).message}`);
}

let consumer: Consumer;
let consumerGeneration = 0;

/**
 * Start (or restart) the consumer. kafkajs restarts itself on retriable errors
 * but gives up for good on "non-retriable" ones, which a broker restart can
 * produce. We treat every crash the same way: wait, build a fresh consumer,
 * resume from the last committed offsets. Nothing is lost; up to one flush
 * interval of events may be re-applied (raw events dedupe, rollups may
 * over-count that second).
 */
async function startConsumer(): Promise<void> {
  const gen = ++consumerGeneration;
  let backoff = 1_000;
  for (;;) {
    try {
      const c = kafka.consumer({ groupId: config.groupId, sessionTimeout: 30_000, heartbeatInterval: 3_000, retry: { retries: 8 } });
      c.on(c.events.CRASH, ({ payload }) => {
        if (payload.restart) return; // kafkajs is handling it
        log(`consumer crashed (${payload.error.message}); restarting`);
        pendingOffsets.clear();
        setTimeout(() => void startConsumer(), 3_000);
      });
      await c.connect();
      await c.subscribe({ topic: config.topic, fromBeginning: false });
      consumer = c;
      await runConsumer(c);
      log(`consuming ${config.topic} as ${config.groupId} (${config.instanceId}, generation ${gen})`);
      return;
    } catch (err) {
      log(`consumer start failed (${(err as Error).message}); retrying in ${backoff} ms`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 15_000);
    }
  }
}

async function runConsumer(c: Consumer): Promise<void> {
  await c.run({
  autoCommit: false,
  eachBatchAutoResolve: true,
  eachBatch: async ({ batch, heartbeat }) => {
    for (const m of batch.messages) {
      if (!m.value) continue;
      let e: TxnMetricEvent;
      try {
        e = JSON.parse(m.value.toString()) as TxnMetricEvent;
      } catch {
        invalidCounter.add(1);
        continue;
      }
      acc.add(e);
      processedTotal++;
      processedCounter.add(1);
      const cls = outcomeClass(e.outcomeCode);
      txnCounter.add(1, { tenant: e.tenantId, vendor: e.vendor, msg_type: e.msgType, outcome_class: cls });
      if (e.amount) amountCounter.add(e.amount, { tenant: e.tenantId, vendor: e.vendor });
      latencyHist.record(e.latencyMs, { tenant: e.tenantId, vendor: e.vendor });
    }
    if (batch.messages.length) {
      pendingOffsets.set(batch.partition, String(Number(batch.lastOffset()) + 1));
    }
    // Back-pressure toward Kafka, never toward the connector: if Postgres is
    // slow, stop fetching until the next flush drains what we hold.
    if (!paused && acc.size >= config.pauseThreshold) {
      paused = true;
      consumer.pause([{ topic: config.topic }]);
      log(`paused consumer at ${acc.size} buffered events`);
    }
    await heartbeat();
  },
  });
}

await startConsumer();

// --- flush loop --------------------------------------------------------------------
async function flush(): Promise<void> {
  if (flushing) return;
  const current = acc;
  if (current.size === 0) {
    await writeHeartbeat(redis, config.instanceId, newestEventMs, processedTotal).catch(() => {});
    return;
  }
  flushing = true;
  acc = new Accumulator();
  const offsets = [...pendingOffsets.entries()];
  pendingOffsets.clear();
  const t0 = Date.now();
  try {
    await Promise.all([
      writeRollups(pool, "txn_rollup_1m", [...current.rollup1m.values()]),
      writeRollups(pool, "txn_rollup_5m", [...current.rollup5m.values()]),
      writeEvents(pool, current.events),
      writeLive(redis, [...current.live.values()], config.liveTtlSec).catch((e) => log(`live write failed (non-fatal): ${e.message}`)),
    ]);
    if (current.newestEventMs > newestEventMs) newestEventMs = current.newestEventMs;
    // Durable writes done; now it is safe to tell Kafka we are past these offsets.
    if (offsets.length) {
      try {
        // Time-boxed: a commit must never hold up the next flush of data that is
        // already durable. If Kafka is down the next successful commit covers it.
        await Promise.race([
          consumer.commitOffsets(offsets.map(([partition, offset]) => ({ topic: config.topic, partition, offset }))),
          new Promise((_, reject) => setTimeout(() => reject(new Error("commit timed out")), 5_000)),
        ]);
      } catch (err) {
        // Typically a rebalance or a consumer mid-restart; the data is written, and the
        // replacement consumer will re-read from the last commit (dedupe covers raw events).
        log(`offset commit failed (${(err as Error).message}); continuing`);
      }
    }
    await writeHeartbeat(redis, config.instanceId, newestEventMs, processedTotal).catch(() => {});
    const ms = Date.now() - t0;
    if (ms > config.flushMs) log(`slow flush: ${current.size} events in ${ms} ms`);
  } catch (err) {
    // Writes failed: put the events back in front of the new accumulator so the
    // next flush retries them, and leave offsets uncommitted.
    flushErrors.add(1);
    log(`flush failed, retrying next tick: ${(err as Error).message}`);
    const merged = new Accumulator();
    for (const e of current.events) merged.add(e);
    for (const e of acc.events) merged.add(e);
    acc = merged;
    for (const [p, o] of offsets) if (!pendingOffsets.has(p)) pendingOffsets.set(p, o);
  } finally {
    flushing = false;
    if (paused && acc.size < config.pauseThreshold / 2) {
      paused = false;
      consumer.resume([{ topic: config.topic }]);
      log("resumed consumer");
    }
  }
}

const flushTimer = setInterval(() => void flush(), config.flushMs);

// --- partition maintenance -------------------------------------------------------------
const partitionTimer = setInterval(async () => {
  try {
    const r = await maintainPartitions(pool);
    if (r.created.length || r.dropped.length) log(`partitions: created=${r.created.join(",") || "-"} dropped=${r.dropped.join(",") || "-"}`);
  } catch (err) {
    log(`partition maintenance failed: ${(err as Error).message}`);
  }
}, 60_000);

const statusTimer = setInterval(() => {
  const lag = newestEventMs ? ((Date.now() - newestEventMs) / 1000).toFixed(1) : "n/a";
  log(`processed=${processedTotal} buffered=${acc.size} lag=${lag}s paused=${paused}`);
}, 10_000);

async function shutdown() {
  clearInterval(flushTimer);
  clearInterval(partitionTimer);
  clearInterval(statusTimer);
  await consumer.stop().catch(() => {});
  await flush();
  await consumer.disconnect().catch(() => {});
  await otel.shutdown().catch(() => {});
  redis.disconnect();
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
