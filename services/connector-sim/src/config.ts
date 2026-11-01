export const config = {
  brokers: (process.env.KAFKA_BROKERS ?? "localhost:9092").split(","),
  topic: process.env.KAFKA_TOPIC ?? "txn-metrics",
  topicPartitions: Number(process.env.KAFKA_TOPIC_PARTITIONS ?? 6),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://nymbus:nymbus@localhost:5432/nymbus",
  controlPort: Number(process.env.SIM_CONTROL_PORT ?? 4100),
  tenantCount: Number(process.env.SIM_TENANTS ?? 50),
  tpsScale: Number(process.env.SIM_TPS_SCALE ?? 1),
  /** Generation tick. 100 ms keeps per-tick Poisson draws small and traffic smooth. */
  tickMs: 100,
};
