import type { MessageType, TxnFamily } from "./iso8583";

/**
 * The per-transaction metric event the connector emits. Deliberately small:
 * only the attributes operators filter by, plus the two measures (amount,
 * latency). No PAN, no track data, no cardholder information ever leaves the
 * connector in this event.
 */
export interface TxnMetricEvent {
  /** UUID assigned by the connector; lets downstream dedupe on replay. */
  eventId: string;
  /** When the connector finished processing (ISO 8601). */
  occurredAt: string;
  tenantId: string;
  /** EFT vendor the message arrived from. */
  vendor: string;
  /** Logical connection / source system identifier within the vendor. */
  sourceConn: string;
  msgType: MessageType;
  txnFamily: TxnFamily;
  /** ISO 8583 DE39 response code. */
  outcomeCode: string;
  /** Transaction amount in major units; 0 for non-financial messages. */
  amount: number;
  /** End-to-end connector processing latency in milliseconds. */
  latencyMs: number;
  /** Systems trace audit number (DE11), for correlating back to the platform log. */
  stan: string;
  /** Issuing BIN the message was routed on (first 6 of PAN; not sensitive on its own). */
  bin: string;
}

/** Tenant identifier reserved for platform-level traffic (network management messages). */
export const PLATFORM_TENANT_ID = "platform";

export const VENDORS = {
  northgate: { label: "NorthGate EFT" },
  meridian: { label: "Meridian Switch" },
  atlas: { label: "Atlas Pay" },
  cardinal: { label: "Cardinal Networks" },
  summit: { label: "Summit EFT" },
} as const;
export type Vendor = keyof typeof VENDORS;
