import { hostname } from "node:os";

export const config = {
  brokers: (process.env.KAFKA_BROKERS ?? "localhost:9092").split(","),
  topic: process.env.KAFKA_TOPIC ?? "txn-metrics",
  topicPartitions: Number(process.env.KAFKA_TOPIC_PARTITIONS ?? 6),
  groupId: process.env.AGG_GROUP_ID ?? "txn-metrics-aggregator",
  databaseUrl: process.env.DATABASE_URL ?? "postgres://nymbus:nymbus@localhost:5432/nymbus",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  /** How often accumulated state is written out and offsets committed. */
  flushMs: Number(process.env.AGG_FLUSH_MS ?? 1000),
  /** Pause the consumer if this many raw events are waiting for a flush (DB is falling behind). */
  pauseThreshold: Number(process.env.AGG_PAUSE_THRESHOLD ?? 50_000),
  /** Seconds the live (1 s) buckets stay in Valkey. */
  liveTtlSec: 15 * 60,
  instanceId: process.env.AGG_INSTANCE_ID ?? `${hostname()}-${process.pid}`,
};
