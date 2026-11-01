/** Tiny TTL cache keyed by scope + query. Many operators watching the same view should cost one query. */
export class TtlCache<T> {
  private store = new Map<string, { exp: number; p: Promise<T> }>();
  constructor(private ttlMs: number) {}

  async get(key: string, fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.store.get(key);
    if (hit && hit.exp > now) return hit.p;
    const p = fn();
    this.store.set(key, { exp: now + this.ttlMs, p });
    p.catch(() => this.store.delete(key));
    if (this.store.size > 500) for (const [k, v] of this.store) if (v.exp <= now) this.store.delete(k);
    return p;
  }
}
