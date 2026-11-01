import { performance } from "node:perf_hooks";
import type { TxnMetricEvent } from "@nymbus/shared";
import type { MetricsEmitter } from "@nymbus/metrics-emitter";

/**
 * Stand-in for the platform's connector: the component every ISO 8583 message
 * passes through. In the real service this is where the response has just been
 * written back to the vendor socket, and where one extra line calls the emitter.
 *
 * We time that one line. The overhead reservoir is the evidence that metrics
 * capture costs the authorization path microseconds, not milliseconds.
 */
export class Connector {
  private overhead = new Float64Array(4096);
  private overheadIdx = 0;
  private overheadFilled = 0;
  private processed = 0;
  private perSecond: number[] = new Array(10).fill(0);
  private lastSecond = Math.floor(Date.now() / 1000);

  constructor(private readonly emitter: MetricsEmitter) {}

  /** Called once per processed message, after the response is sent to the vendor. */
  complete(event: TxnMetricEvent): void {
    const t0 = performance.now();
    this.emitter.emit(event); // <- the instrumentation point. Sync, non-blocking, never throws.
    const dt = performance.now() - t0;

    this.overhead[this.overheadIdx] = dt;
    this.overheadIdx = (this.overheadIdx + 1) % this.overhead.length;
    if (this.overheadFilled < this.overhead.length) this.overheadFilled++;

    this.processed++;
    const sec = Math.floor(Date.now() / 1000);
    if (sec !== this.lastSecond) {
      for (let s = this.lastSecond + 1; s <= sec; s++) this.perSecond[s % 10] = 0;
      this.lastSecond = sec;
    }
    this.perSecond[sec % 10]++;
  }

  /** Mean throughput over the last 5 complete seconds. */
  currentTps(): number {
    const sec = Math.floor(Date.now() / 1000);
    let sum = 0;
    for (let i = 1; i <= 5; i++) sum += this.perSecond[(sec - i + 10) % 10] ?? 0;
    return sum / 5;
  }

  stats() {
    const n = this.overheadFilled;
    const sorted = Array.from(this.overhead.subarray(0, n)).sort((a, b) => a - b);
    const q = (p: number) => (n === 0 ? 0 : sorted[Math.min(n - 1, Math.floor(p * n))]);
    return {
      processed: this.processed,
      currentTps: Math.round(this.currentTps() * 10) / 10,
      emitOverheadMs: {
        p50: round(q(0.5)),
        p99: round(q(0.99)),
        max: round(sorted[n - 1] ?? 0),
        samples: n,
      },
    };
  }
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}
