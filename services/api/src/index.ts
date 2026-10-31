import Fastify from "fastify";
import cors from "@fastify/cors";
import { APP_NAME, type HealthResponse } from "@nymbus/shared";

// Stand-in for the existing platform backend service. Connector instrumentation,
// metrics aggregation, and dashboard query endpoints will be added here.

const port = Number(process.env.API_PORT ?? 4000);

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

app.get("/health", async (): Promise<HealthResponse> => ({
  status: "ok",
  service: APP_NAME,
  timestamp: new Date().toISOString(),
}));

try {
  await app.listen({ port, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
