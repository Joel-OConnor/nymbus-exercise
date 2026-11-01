export { MetricsEmitter, type MetricsEmitterOptions, type EmitterStats } from "./emitter";
export { ensureTopic } from "./topic";

/**
 * kafkajs schedules a throttle timer with a negative delay on first connect,
 * which Node 24+ reports as TimeoutNegativeWarning. It is harmless; hide that
 * one warning and leave every other warning intact.
 */
export function quietKafkaJsTimeoutWarning(): void {
  const listeners = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (w) => {
    if (w.name === "TimeoutNegativeWarning") return;
    for (const l of listeners) l(w);
  });
}
