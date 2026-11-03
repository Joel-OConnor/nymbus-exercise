import { describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { resolveScope } from "./scope";

function run(headers: Record<string, string>) {
  const req = { headers } as unknown as FastifyRequest;
  const send = vi.fn();
  const reply = { code: vi.fn(() => ({ send })), send } as unknown as FastifyReply;
  const done = vi.fn();
  resolveScope(req, reply, done);
  return { req, reply, send, done };
}

describe("resolveScope", () => {
  it("accepts a global operator", () => {
    const { req, done, send } = run({ "x-role": "global" });
    expect(req.scope).toEqual({ role: "global" });
    expect(done).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it("accepts a tenant admin with a well-formed tenant id", () => {
    const { req, done } = run({ "x-role": "tenant", "x-tenant-id": "t001" });
    expect(req.scope).toEqual({ role: "tenant", tenantId: "t001" });
    expect(done).toHaveBeenCalledOnce();
  });

  it("rejects anonymous requests: there is no public view", () => {
    const { reply, done, send } = run({});
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(send).toHaveBeenCalledOnce();
    expect(done).not.toHaveBeenCalled();
  });

  it("rejects a tenant role without a tenant id", () => {
    const { reply, done } = run({ "x-role": "tenant" });
    expect(reply.code).toHaveBeenCalledWith(401);
    expect(done).not.toHaveBeenCalled();
  });

  it("rejects unknown roles and malformed tenant ids", () => {
    expect(run({ "x-role": "admin" }).done).not.toHaveBeenCalled();
    expect(run({ "x-role": "tenant", "x-tenant-id": "t001; DROP TABLE tenant" }).done).not.toHaveBeenCalled();
    expect(run({ "x-role": "tenant", "x-tenant-id": "*" }).done).not.toHaveBeenCalled();
    expect(run({ "x-role": "tenant", "x-tenant-id": "x".repeat(65) }).done).not.toHaveBeenCalled();
  });

  it("does not let a tenant admin claim the reserved platform tenant", () => {
    const { done, reply } = run({ "x-role": "tenant", "x-tenant-id": "platform" });
    expect(done).not.toHaveBeenCalled();
    expect(reply.code).toHaveBeenCalledWith(401);
  });

  it("does not let a tenant admin claim the global wildcard", () => {
    // '*' is what withScope sets for global; it must never be accepted from a header.
    const { done, reply } = run({ "x-role": "tenant", "x-tenant-id": "*" });
    expect(done).not.toHaveBeenCalled();
    expect(reply.code).toHaveBeenCalledWith(401);
  });
});
