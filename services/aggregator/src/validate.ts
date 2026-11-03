import type { TxnMetricEvent } from "@nymbus/shared";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_TOKEN = /^[\w.:-]{1,64}$/;

/**
 * Shape check for a message off the topic before it touches the accumulator or
 * Postgres. A malformed event must be counted and skipped, never allowed to
 * throw inside the batch handler or fail the flush (a uuid syntax error or a
 * NaN in a bigint column would otherwise stall the partition forever).
 */
export function isValidEvent(e: unknown): e is TxnMetricEvent {
  if (!e || typeof e !== "object") return false;
  const o = e as Record<string, unknown>;
  const token = (k: string) => typeof o[k] === "string" && SHORT_TOKEN.test(o[k] as string);
  return (
    typeof o.eventId === "string" &&
    UUID.test(o.eventId) &&
    typeof o.occurredAt === "string" &&
    Number.isFinite(Date.parse(o.occurredAt)) &&
    token("tenantId") &&
    token("vendor") &&
    token("sourceConn") &&
    token("msgType") &&
    token("txnFamily") &&
    token("outcomeCode") &&
    typeof o.amount === "number" &&
    Number.isFinite(o.amount) &&
    o.amount >= 0 &&
    typeof o.latencyMs === "number" &&
    Number.isInteger(o.latencyMs) &&
    o.latencyMs >= 0 &&
    typeof o.stan === "string" &&
    o.stan.length <= 64 &&
    typeof o.bin === "string" &&
    o.bin.length <= 64
  );
}
