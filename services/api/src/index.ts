import Fastify from "fastify";
import cors from "@fastify/cors";
import Redis from "ioredis";
import { createPool } from "@nymbus/db";
import { config } from "./config";
import { registerRoutes } from "./routes";

const app = Fastify({ logger: { level: "warn" } });
await app.register(cors, { origin: true, allowedHeaders: ["content-type", "x-role", "x-tenant-id"] });

const pool = createPool(config.databaseUrl, { max: 10 });
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
