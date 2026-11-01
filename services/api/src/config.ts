export const config = {
  port: Number(process.env.API_PORT ?? 4000),
  /** Read-only role; RLS policies apply. See packages/db/sql/001_schema.sql. */
  databaseUrl: process.env.API_DATABASE_URL ?? "postgres://dashboard_api:dashboard_api@localhost:5432/nymbus",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  simControlUrl: (process.env.SIM_CONTROL_URL ?? "http://localhost:4100").replace(/\/$/, ""),
  /** Collapse identical dashboard polls from many browser tabs into one DB query. */
  cacheTtlMs: 1500,
};
