import Fastify from "fastify";
import cors from "@fastify/cors";
import Redis from "ioredis";
import { createPool } from "@nymbus/db";
import { config } from "./config";
import { registerRoutes } from "./routes";

const app = Fastify({ logger: { level: "warn" } });
await app.register(cors, {
  origin: true,
  // @fastify/cors defaults to GET,HEAD,POST; the demo-only sim proxy cancels scenarios with DELETE.
  methods: ["GET", "HEAD", "POST", "DELETE"],
  allowedHeaders: ["content-type", "x-role", "x-tenant-id"],
});

const pool = createPool(config.databaseUrl, { max: 10 });

// Fail closed: row-level security does not apply to a table's owner, a superuser
// or a BYPASSRLS role. If API_DATABASE_URL points at one of those, every tenant
// fence in this service is paper. Refuse to start rather than serve.
try {
  const r = await pool.query<{ user: string; owner: string | null; superuser: boolean; bypass: boolean }>(
    `SELECT current_user AS "user",
            (SELECT tableowner FROM pg_tables WHERE tablename = 'txn_rollup_1m') AS owner,
            rolsuper AS superuser, rolbypassrls AS bypass
       FROM pg_roles WHERE rolname = current_user`,
  );
  const w = r.rows[0];
  if (w && (w.superuser || w.bypass || (w.owner !== null && w.owner === w.user))) {
    app.log.error(`refusing to start as "${w.user}": this role bypasses row-level security (owner=${w.owner}, superuser=${w.superuser}, bypassrls=${w.bypass}). Point API_DATABASE_URL at the dashboard_api role.`);
    process.exit(1);
  }
} catch (err) {
  app.log.warn(`could not verify the database role at startup (${(err as Error).message}); continuing`);
}

const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1 });
redis.on("error", (e) => app.log.warn(`valkey: ${e.message}`));

registerRoutes(app, pool, redis);

app.setErrorHandler((err, _req, reply) => {
  const status = (err as { statusCode?: number }).statusCode ?? 500;
  if (status >= 500) app.log.error(err as Error);
  reply.code(status).send({ error: (err as Error).message });
});

try {
  await app.listen({ port: config.port, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err as Error);
  process.exit(1);
}

async function shutdown() {
  await app.close();
  redis.disconnect();
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
