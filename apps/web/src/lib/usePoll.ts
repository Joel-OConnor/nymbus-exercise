"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Poll an async source on an interval. Keeps the last good value while a
 * refresh is in flight or failing, so the dashboard never flickers to empty.
 * The brief asks for "a few seconds behind live"; polling is the simplest thing
 * that honours that and stays stateless across horizontally scaled API pods.
 */
export function usePoll<T>(fn: () => Promise<T>, intervalMs: number, deps: unknown[]): { data?: T; error?: string; updatedAt?: number } {
  const [state, setState] = useState<{ data?: T; error?: string; updatedAt?: number }>({});
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const data = await fnRef.current();
        if (!cancelled) setState({ data, updatedAt: Date.now() });
      } catch (err) {
        if (!cancelled) setState((s) => ({ ...s, error: (err as Error).message }));
      } finally {
        if (!cancelled) timer = setTimeout(tick, intervalMs);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, ...deps]);

  return state;
}
