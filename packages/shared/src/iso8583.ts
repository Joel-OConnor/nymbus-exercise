/**
 * Reference data for the slice of ISO 8583 that matters to the dashboard.
 * The platform's real connector parses full messages; the metrics pipeline only
 * carries the handful of attributes operators slice by.
 */

/** Message Type Indicator (DE0). */
export const MESSAGE_TYPES = {
  "0100": { label: "Authorization request", financial: true },
  "0200": { label: "Financial request", financial: true },
  "0220": { label: "Financial advice", financial: true },
  "0400": { label: "Reversal request", financial: true },
  "0420": { label: "Reversal advice", financial: true },
  "0800": { label: "Network management", financial: false },
} as const;
export type MessageType = keyof typeof MESSAGE_TYPES;

/** Transaction family, derived from the processing code (DE3, first two digits). */
export const TXN_FAMILIES = {
  purchase: { label: "Purchase", processingCode: "00" },
  withdrawal: { label: "Withdrawal", processingCode: "01" },
  deposit: { label: "Deposit", processingCode: "21" },
  transfer: { label: "Transfer", processingCode: "40" },
  payment: { label: "Payment", processingCode: "50" },
  network: { label: "Network", processingCode: "99" },
} as const;
export type TxnFamily = keyof typeof TXN_FAMILIES;

export type OutcomeClass =
  | "approved"
  | "soft_decline"
  | "hard_decline"
  | "system_error"
  | "format_error";

/** Response code (DE39). Classes group codes the way an operator triages them. */
export const OUTCOME_CODES: Record<string, { label: string; class: OutcomeClass }> = {
  "00": { label: "Approved", class: "approved" },
  "05": { label: "Do not honor", class: "soft_decline" },
  "14": { label: "Invalid card number", class: "hard_decline" },
  "30": { label: "Format error", class: "format_error" },
  "41": { label: "Lost card", class: "hard_decline" },
  "43": { label: "Stolen card", class: "hard_decline" },
  "51": { label: "Insufficient funds", class: "soft_decline" },
  "54": { label: "Expired card", class: "hard_decline" },
  "55": { label: "Incorrect PIN", class: "soft_decline" },
  "57": { label: "Txn not permitted to cardholder", class: "hard_decline" },
  "61": { label: "Exceeds withdrawal limit", class: "soft_decline" },
  "65": { label: "Exceeds frequency limit", class: "soft_decline" },
  "75": { label: "PIN tries exceeded", class: "hard_decline" },
  "91": { label: "Issuer unavailable", class: "system_error" },
  "96": { label: "System malfunction", class: "system_error" },
};

export function outcomeClass(code: string): OutcomeClass {
  return OUTCOME_CODES[code]?.class ?? "system_error";
}

export function outcomeLabel(code: string): string {
  return OUTCOME_CODES[code]?.label ?? `Code ${code}`;
}
