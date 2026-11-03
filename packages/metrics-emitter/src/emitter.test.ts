import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TxnMetricEvent } from "@nymbus/shared";

/**
 * These tests pin the emitter's contract with the authorization path:
 * emit() is synchronous and bounded, failures never propagate, and the buffer
 * drains in batches keyed by tenant. kafkajs is replaced with a fake producer.
 */
const fake = vi.hoisted(() => ({
  connect: vi.fn<() => Promise<void>>(),
  disconnect: vi.fn<() => Promise<void>>(),
  send: vi.fn<(args: { messages: { key: string; value: string }[] }) => Promise<void>>(),
}));

vi.mock("kafkajs", () => ({
  Kafka: class {
    producer() {
      return { connect: fake.connect, disconnect: fake.disconnect, send: fake.send };
    }
  },
  Partitioners: { DefaultPartitioner: () => () => 0 },
  logLevel: { NOTHING: 0 },
}));

import { MetricsEmitter } from "./emitter";

function event(i: number, tenantId = `t${String((i % 3) + 1).padStart(3, "0")}`): TxnMetricEvent {
  return {
    eventId: `e${i}`,
    occurredAt: "2026-11-03T12:00:00.000Z",
    tenantId,
    vendor: "atlas",
    sourceConn: "atlas-1",
    msgType: "0200",
    txnFamily: "purchase",
    outcomeCode: "00",
    amount: 1,
    latencyMs: 100,
    stan: "000001",
    bin: "400000",
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

function make(opts: Partial<ConstructorParameters<typeof MetricsEmitter>[0]> = {}) {
  return new MetricsEmitter({ brokers: ["kafka:9092"], topic: "txn-metrics", ...opts });
}

beforeEach(() => {
  fake.connect.mockReset().mockResolvedValue();
  fake.disconnect.mockReset().mockResolvedValue();
  fake.send.mockReset().mockResolvedValue();
});

describe("MetricsEmitter.emit", () => {
  it("is synchronous, returns immediately, and works before Kafka is connected", () => {
    const em = make();
    expect(em.emit(event(1))).toBe(true);
    expect(em.getStats()).toMatchObject({ emitted: 1, sent: 0, dropped: 0, bufferSize: 1, connected: false });
  });

  it("drops and counts once the buffer reaches its cap instead of growing or throwing", () => {
    const onDrop = vi.fn();
    const em = make({ maxBuffer: 3, onDrop });
    expect([1, 2, 3].map((i) => em.emit(event(i)))).toEqual([true, true, true]);
    expect(em.emit(event(4))).toBe(false);
    expect(em.emit(event(5))).toBe(false);
    expect(em.getStats()).toMatchObject({ emitted: 5, dropped: 2, bufferSize: 3 });
    expect(onDrop).toHaveBeenCalledTimes(2);
  });

  it("costs a few microseconds per call at 150 tps worth of events", () => {
    const em = make({ maxBuffer: 100_000 });
    const t0 = performance.now();
    for (let i = 0; i < 10_000; i++) em.emit(event(i));
    const perCall = (performance.now() - t0) / 10_000;
    expect(perCall).toBeLessThan(0.05); // 50 µs is a generous ceiling for CI machines
  });
});

describe("MetricsEmitter drain", () => {
  it("does nothing until connected, then ships the buffer in tenant-keyed batches", async () => {
    const em = make();
    for (let i = 0; i < 1200; i++) em.emit(event(i));
    await (em as any).drain();
    expect(fake.send).not.toHaveBeenCalled();

    await (em as any).connect();
    expect(em.getStats().connected).toBe(true);
    await (em as any).drain();
    await settle();

    expect(fake.send).toHaveBeenCalledTimes(3);
    const sizes = fake.send.mock.calls.map(([args]) => args.messages.length);
    expect(sizes).toEqual([500, 500, 200]);
    const first = fake.send.mock.calls[0][0];
    expect(first).toMatchObject({ topic: "txn-metrics", acks: 1 });
    expect(first.messages[0].key).toBe("t001");
    expect(JSON.parse(first.messages[0].value).eventId).toBe("e0");
    expect(em.getStats()).toMatchObject({ sent: 1200, bufferSize: 0, inflight: 0, failed: 0 });
  });

  it("bounds concurrency to maxInflight sends per tick", async () => {
    const em = make({ maxInflight: 2 });
    let release!: () => void;
    fake.send.mockImplementation(() => new Promise<void>((r) => (release = r)));
    for (let i = 0; i < 1500; i++) em.emit(event(i));
    await (em as any).connect();
    await (em as any).drain();
    expect(fake.send).toHaveBeenCalledTimes(2);
    expect(em.getStats()).toMatchObject({ inflight: 2, bufferSize: 500 });
    release();
  });

  it("puts a failed batch back, counts it, marks Kafka down and reconnects, without throwing", async () => {
    const log = vi.fn();
    const em = make({ log });
    await (em as any).connect();
    expect(fake.connect).toHaveBeenCalledTimes(1);

    fake.send.mockRejectedValueOnce(new Error("broker gone"));
    for (let i = 0; i < 10; i++) em.emit(event(i));
    await (em as any).drain();
    await settle();

    expect(em.getStats()).toMatchObject({ failed: 10, sent: 0, bufferSize: 10, dropped: 0 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("send failed (broker gone); buffering until Kafka is back"));
    // The reconnect loop ran (connect resolves in the fake, so we're healthy again).
    expect(fake.connect).toHaveBeenCalledTimes(2);
    expect(em.getStats().connected).toBe(true);

    // Next drain ships the requeued events in order.
    await (em as any).drain();
    await settle();
    expect(em.getStats()).toMatchObject({ sent: 10, bufferSize: 0 });
    expect(JSON.parse(fake.send.mock.calls.at(-1)![0].messages[0].value).eventId).toBe("e0");
  });

  it("trims the oldest events when a requeued batch would overflow the cap", async () => {
    const em = make({ maxBuffer: 5 });
    await (em as any).connect();
    let fail!: (e: Error) => void;
    fake.send.mockImplementationOnce(() => new Promise<void>((_, rej) => (fail = rej)));
    for (let i = 0; i < 5; i++) em.emit(event(i));
    await (em as any).drain(); // batch of 5 in flight, buffer empty
    for (let i = 5; i < 10; i++) em.emit(event(i)); // buffer full again
    fail(new Error("timeout"));
    await settle();
    expect(em.getStats()).toMatchObject({ bufferSize: 5, dropped: 5, failed: 5 });
    // The newest five survived; the requeued originals were the ones trimmed.
    expect(((em as any).buffer as TxnMetricEvent[]).map((e) => e.eventId)).toEqual(["e5", "e6", "e7", "e8", "e9"]);
  });

  it("keeps emit() cheap and non-throwing while Kafka is down", async () => {
    const em = make();
    fake.connect.mockRejectedValue(new Error("ECONNREFUSED"));
    void (em as any).connect();
    for (let i = 0; i < 100; i++) expect(em.emit(event(i))).toBe(true);
    expect(em.getStats()).toMatchObject({ bufferSize: 100, connected: false });
    (em as any).stopping = true; // end the backoff loop
  });
});

describe("MetricsEmitter lifecycle", () => {
  it("stop() drains what is buffered and disconnects", async () => {
    const em = make();
    em.start();
    await settle();
    for (let i = 0; i < 7; i++) em.emit(event(i));
    await em.stop();
    await settle();
    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
    expect(em.getStats()).toMatchObject({ sent: 7, connected: false });
  });
});
