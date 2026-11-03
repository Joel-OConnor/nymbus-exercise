import type { FreshnessResponse } from "@nymbus/shared";

interface Heartbeat {
  lastEventAt: string | null;
  flushedAt: string;
  processed: number;
}

/**
 * Turn the aggregators' heartbeat hash into the freshness badge. Replicas that
 * have not flushed within `staleAfterMs` are considered gone. The reported lag
 * is that of the *slowest* live replica: each replica owns a slice of the
 * tenants, so a stalled one must not be masked by a healthy one.
 */
export function summarizeFreshness(raw: Record<string, string>, now: number = Date.now(), staleAfterMs = 30_000): FreshnessResponse {
  const aggregators = Object.entries(raw)
    .flatMap(([instance, v]) => {
      try {
        const h = JSON.parse(v) as Heartbeat;
        return typeof h.flushedAt === "string" ? [{ instance, lastEventAt: h.lastEventAt ?? null, flushedAt: h.flushedAt, processed: Number(h.processed) || 0 }] : [];
      } catch {
        return [];
      }
    })
    .filter((a) => Date.parse(a.flushedAt) >= now - staleAfterMs)
    .sort((a, b) => a.instance.localeCompare(b.instance));

  const times = aggregators.map((a) => (a.lastEventAt ? Date.parse(a.lastEventAt) : Number.NaN)).filter(Number.isFinite);
  const oldest = times.length ? Math.min(...times) : 0;
  return {
    lagSeconds: oldest ? Math.max(0, Math.round(((now - oldest) / 1000) * 10) / 10) : null,
    lastEventAt: oldest ? new Date(oldest).toISOString() : null,
    aggregators,
  };
}
