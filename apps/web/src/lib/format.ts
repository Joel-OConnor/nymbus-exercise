export const fmtInt = (n: number) => new Intl.NumberFormat("en-US").format(Math.round(n));

export function fmtCompact(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(2)}k`;
  return fmtInt(n);
}

export function fmtMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

export const fmtPct = (num: number, den: number, digits = 1) => (den ? `${((100 * num) / den).toFixed(digits)}%` : "–");
export const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);

export function fmtTime(iso: string, withSeconds = false): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", ...(withSeconds ? { second: "2-digit" } : {}) });
}

export function fmtClock(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export const OUTCOME_CLASS_COLORS: Record<string, string> = {
  approved: "#2dd4bf",
  soft_decline: "#f59e0b",
  hard_decline: "#fb7185",
  system_error: "#ef4444",
  format_error: "#a78bfa",
};

export const OUTCOME_CLASS_LABELS: Record<string, string> = {
  approved: "Approved",
  soft_decline: "Soft decline",
  hard_decline: "Hard decline",
  system_error: "System error",
  format_error: "Format error",
};

export const LATENCY_BUDGET_MS = 500;
