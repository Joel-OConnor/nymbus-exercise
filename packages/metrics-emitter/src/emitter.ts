import { Kafka, Partitioners, type Producer, logLevel } from "kafkajs";
import type { TxnMetricEvent } from "@nymbus/shared";

/**
 * MetricsEmitter: the connector-side instrumentation point.
 *
 * Design contract (the part that matters for the sub-500 ms auth path):
 *   - `emit()` is synchronous, never awaits, never throws, and does O(1) work:
 *     it pushes onto an in-memory array and returns. The hot path pays a few
 *     microseconds regardless of Kafka's health.
 *   - A background timer drains the buffer into batched, bounded-concurrency
 *     producer sends. Send failures are counted, never propagated.
 *   - The buffer has a hard cap. When Kafka is slow or down and the buffer
 *     fills, new events are dropped and counted. Visibility degrades; payments
 *     do not. The drop counter is exported so the degradation itself is visible.
 *
 * Events are keyed by tenant so a tenant's events land on one partition in
 * order, and so the aggregator can be scaled by partition.
 */
export interface MetricsEmitterOptions {
  brokers: string[];
  topic: string;
  clientId?: string;
  /** Hard cap on buffered events. At 150 tps, 10k is ~65 s of outage tolerance. */
  maxBuffer?: number;
  /** How often the background drain runs. */
  flushIntervalMs?: number;
  /** Max events per producer.send call. */
  maxBatch?: number;
  /** Max concurrent in-flight sends. */
  maxInflight?: number;
  onDrop?: (count: number) => void;
  log?: (msg: string) => void;
}

export interface EmitterStats {
  emitted: number;
  sent: number;
  dropped: number;
  failed: number;
  bufferSize: number;
  inflight: number;
  connected: boolean;
  lastError?: string;
}

export class MetricsEmitter {
  private readonly opts: Required<Omit<MetricsEmitterOptions, "onDrop" | "log">> & Pick<MetricsEmitterOptions, "onDrop" | "log">;
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private buffer: TxnMetricEvent[] = [];
  private timer?: NodeJS.Timeout;
  private inflight = 0;
  private connected = false;
  private stopping = false;
  private stats = { emitted: 0, sent: 0, dropped: 0, failed: 0 };
  private lastError?: string;

  constructor(options: MetricsEmitterOptions) {
    this.opts = {
      clientId: "connector-metrics",
      maxBuffer: 10_000,
      flushIntervalMs: 250,
      maxBatch: 500,
      maxInflight: 4,
      ...options,
    };
    this.kafka = new Kafka({
      clientId: this.opts.clientId,
      brokers: this.opts.brokers,
      logLevel: logLevel.NOTHING,
      retry: { retries: 3, initialRetryTime: 200, maxRetryTime: 2_000 },
    });
    this.producer = this.kafka.producer({
      createPartitioner: Partitioners.DefaultPartitioner,
      allowAutoTopicCreation: false,
      // acks=1: leader ack only. This is telemetry, not the ledger; we trade a
      // sliver of durability for lower producer latency and less broker load.
      // (The real ISO 8583 response has already gone back to the vendor.)
      idempotent: false,
      maxInFlightRequests: this.opts.maxInflight,
    });
  }

  /** Connects in the background; emit() works immediately (events buffer until connected). */
  start(): void {
    this.stopping = false;
    void this.connect();
    this.timer = setInterval(() => void this.drain(), this.opts.flushIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.drain();
    try {
      await this.producer.disconnect();
    } catch {
      /* ignore */
    }
    this.connected = false;
  }

  /**
   * Hot-path call. Synchronous, non-blocking, never throws.
   * Returns false if the event was dropped because the buffer is full.
   */
  emit(event: TxnMetricEvent): boolean {
    this.stats.emitted++;
    if (this.buffer.length >= this.opts.maxBuffer) {
      this.stats.dropped++;
      this.opts.onDrop?.(1);
      return false;
    }
    this.buffer.push(event);
    return true;
  }

  getStats(): EmitterStats {
    return {
      ...this.stats,
      bufferSize: this.buffer.length,
      inflight: this.inflight,
      connected: this.connected,
      lastError: this.lastError,
    };
  }

  private connecting = false;

  private async connect(): Promise<void> {
    if (this.connecting) return;
    this.connecting = true;
    let backoff = 500;
    try {
      while (!this.stopping && !this.connected) {
        try {
          await this.producer.connect();
          this.connected = true;
          this.lastError = undefined;
          this.opts.log?.(`metrics emitter connected to ${this.opts.brokers.join(",")} (buffer ${this.buffer.length})`);
        } catch (err) {
          this.lastError = (err as Error).message || String(err);
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 5_000);
        }
      }
    } finally {
      this.connecting = false;
    }
  }

  /** Put a failed batch back in front of newer events, dropping the oldest if the cap is exceeded. */
  private requeue(batch: TxnMetricEvent[]): void {
    this.buffer.unshift(...batch);
    const overflow = this.buffer.length - this.opts.maxBuffer;
    if (overflow > 0) {
      this.buffer.splice(0, overflow);
      this.stats.dropped += overflow;
      this.opts.onDrop?.(overflow);
    }
  }

  private async drain(): Promise<void> {
    if (!this.connected || this.stopping) return;
    while (this.buffer.length > 0 && this.inflight < this.opts.maxInflight) {
      const batch = this.buffer.splice(0, this.opts.maxBatch);
      this.inflight++;
      void this.send(batch).finally(() => {
        this.inflight--;
      });
    }
  }

  private async send(batch: TxnMetricEvent[]): Promise<void> {
    try {
      await this.producer.send({
        topic: this.opts.topic,
        acks: 1,
        timeout: 5_000,
        messages: batch.map((e) => ({
          key: e.tenantId,
          value: JSON.stringify(e),
          timestamp: String(Date.parse(e.occurredAt)),
        })),
      });
      this.stats.sent += batch.length;
      this.lastError = undefined;
    } catch (err) {
      // Telemetry loss is acceptable; blocking or crashing the connector is not.
      // Treat any send failure as "Kafka is unhealthy": put the batch back at the
      // head of the buffer (bounded: the oldest events are dropped if it no longer
      // fits), stop draining, and reconnect in the background with backoff.
      this.stats.failed += batch.length;
      this.lastError = (err as Error).message || String(err);
      this.requeue(batch);
      if (this.connected) {
        this.connected = false;
        this.opts.log?.(`metrics emitter: send failed (${this.lastError}); buffering until Kafka is back`);
        void this.connect();
      }
    }
  }
}
