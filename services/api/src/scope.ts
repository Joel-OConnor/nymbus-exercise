import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "@nymbus/db";
import type { Scope } from "@nymbus/shared";

declare module "fastify" {
  interface FastifyRequest {
    scope: Scope;
  }
}

/**
 * Resolve who is asking. The real console already authenticates users and
 * knows their tenant; this API would read that from the session/JWT. For the
 * prototype the dashboard sends two headers:
 *   x-role: global | tenant
 *   x-tenant-id: <tenant>   (required for tenant)
 * A missing or malformed identity is rejected: there is no anonymous view.
 */
export function resolveScope(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  const role = String(req.headers["x-role"] ?? "");
  const tenantId = req.headers["x-tenant-id"] ? String(req.headers["x-tenant-id"]) : undefined;
  if (role === "global") {
    req.scope = { role: "global" };
  } else if (role === "tenant" && tenantId && /^[a-z0-9_-]{1,64}$/i.test(tenantId)) {
    req.scope = { role: "tenant", tenantId };
  } else {
    reply.code(401).send({ error: "missing or invalid identity (x-role / x-tenant-id)" });
    return;
  }
  done();
}

/**
 * Run a unit of work inside a transaction with the caller's scope pinned as a
 * session setting. Postgres row-level security reads `app.scope_tenant`, so
 * even a buggy query in this service cannot return another tenant's rows.
 */
export async function withScope<T>(pool: Pool, scope: Scope, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SELECT set_config('app.scope_tenant', $1, true)", [scope.role === "global" ? "*" : scope.tenantId!]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
