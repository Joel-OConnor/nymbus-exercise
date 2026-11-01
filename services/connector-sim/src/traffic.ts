import { randomUUID } from "node:crypto";
import {
  PLATFORM_TENANT_ID,
  type MessageType,
  type TxnFamily,
  type TxnMetricEvent,
  type Vendor,
} from "@nymbus/shared";
import { logNormal, pickWeighted } from "./random";
import type { SimTenant } from "./tenants";
import type { Effects } from "./scenarios";

/**
 * Generates one ISO 8583-shaped transaction as the connector would see it after
 * processing. Distributions are tuned to look like real debit traffic: ~92%
 * approvals, insufficient-funds the top decline, a long latency tail, a small
 * trickle of system and format conditions.
 */

const MTI_WEIGHTS: Record<MessageType, number> = {
  "0200": 0.78,
  "0100": 0.10,
  "0220": 0.04,
  "0400": 0.05,
  "0420": 0.03,
  "0800": 0, // generated separately per vendor connection
};

const FAMILY_WEIGHTS: Record<Exclude<TxnFamily, "network">, number> = {
  purchase: 0.58,
  withdrawal: 0.22,
  deposit: 0.05,
  transfer: 0.10,
  payment: 0.05,
};

const AMOUNT_MEDIAN: Record<Exclude<TxnFamily, "network">, number> = {
  purchase: 42,
  withdrawal: 100,
  deposit: 250,
  transfer: 300,
  payment: 120,
};

const OUTCOME_WEIGHTS: Record<string, number> = {
  "00": 0.925,
  "51": 0.028,
  "05": 0.012,
  "55": 0.010,
  "61": 0.008,
  "14": 0.004,
  "54": 0.004,
  "65": 0.003,
  "57": 0.002,
  "75": 0.001,
  "41": 0.0005,
  "43": 0.0005,
  "91": 0.001,
  "96": 0.0005,
  "30": 0.0005,
};

const SOFT_DECLINES = { "51": 0.6, "05": 0.25, "61": 0.15 };
const SYSTEM_ERRORS = { "91": 0.7, "96": 0.3 };

/** Vendors differ: each has its own typical connector latency profile. */
const VENDOR_LATENCY_MEDIAN_MS: Record<Vendor, number> = {
  northgate: 110,
  meridian: 95,
  atlas: 140,
  cardinal: 120,
  summit: 160,
};

/** Past this the connector gives up on the issuer leg and answers 91. */
const ISSUER_TIMEOUT_MS = 2500;

let stanCounter = Math.floor(Math.random() * 900000);
function nextStan(): string {
  stanCounter = (stanCounter + 1) % 1000000;
  return String(stanCounter).padStart(6, "0");
}

export function generateTransaction(tenant: SimTenant, effects: Effects, now: Date): TxnMetricEvent {
  const msgType = pickWeighted(MTI_WEIGHTS);
  const family = msgType === "0100" && Math.random() < 0.9 ? "purchase" : pickWeighted(FAMILY_WEIGHTS);

  let amount = logNormal(AMOUNT_MEDIAN[family], 0.8);
  if (family === "withdrawal") amount = Math.max(20, Math.round(amount / 20) * 20);
  amount = Math.round(amount * 100) / 100;

  let latencyMs = logNormal(VENDOR_LATENCY_MEDIAN_MS[tenant.vendor], 0.35);
  if (Math.random() < 0.01) latencyMs *= 3; // natural long tail
  latencyMs *= effects.latencyMultiplier;

  let outcome: string;
  const isReversalOrAdvice = msgType === "0400" || msgType === "0420" || msgType === "0220";
  if (isReversalOrAdvice) {
    outcome = Math.random() < 0.985 ? "00" : "96";
  } else if (effects.errorBoost > 0 && Math.random() < effects.errorBoost) {
    outcome = pickWeighted(SYSTEM_ERRORS);
  } else if (effects.declineBoost > 0 && Math.random() < effects.declineBoost) {
    outcome = pickWeighted(SOFT_DECLINES);
  } else {
    outcome = pickWeighted(OUTCOME_WEIGHTS);
  }

  if (latencyMs > ISSUER_TIMEOUT_MS) {
    latencyMs = ISSUER_TIMEOUT_MS + Math.random() * 50;
    outcome = "91";
  }

  return {
    eventId: randomUUID(),
    occurredAt: now.toISOString(),
    tenantId: tenant.tenantId,
    vendor: tenant.vendor,
    sourceConn: `${tenant.vendor}-${(stanCounter % 3) + 1}`,
    msgType,
    txnFamily: family,
    outcomeCode: outcome,
    amount,
    latencyMs: Math.round(latencyMs),
    stan: nextStan(),
    bin: tenant.bins[Math.random() < 0.7 ? 0 : 1],
  };
}

/** Network-management heartbeat (0800) on a vendor connection; platform-level, not tenant traffic. */
export function generateNetworkMessage(vendor: Vendor, now: Date): TxnMetricEvent {
  return {
    eventId: randomUUID(),
    occurredAt: now.toISOString(),
    tenantId: PLATFORM_TENANT_ID,
    vendor,
    sourceConn: `${vendor}-1`,
    msgType: "0800",
    txnFamily: "network",
    outcomeCode: "00",
    amount: 0,
    latencyMs: Math.round(logNormal(12, 0.3)),
    stan: nextStan(),
    bin: "000000",
  };
}
