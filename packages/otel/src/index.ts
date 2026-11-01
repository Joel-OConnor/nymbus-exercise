import { metrics, type Meter } from "@opentelemetry/api";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_INSTANCE_ID } from "@opentelemetry/semantic-conventions/incubating";

/**
 * Wire a service into the platform's existing OpenTelemetry collector. This is
 * the ">24 hours" leg: the collector forwards to the long-term observability
 * stack (Prometheus/Grafana locally). Metrics exported here are intentionally
 * lower-cardinality than the Postgres rollups: outcome is reduced to its class,
 * and nothing per-transaction leaves the service.
 */
export function initMetrics(serviceName: string, opts: { endpoint?: string; instanceId?: string; intervalMs?: number } = {}): {
  meter: Meter;
  shutdown: () => Promise<void>;
} {
  const endpoint = (opts.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318").replace(/\/$/, "");
  const exporter = new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` });
  const provider = new MeterProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_INSTANCE_ID]: opts.instanceId ?? `${serviceName}-${process.pid}`,
    }),
    readers: [new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: opts.intervalMs ?? 5_000 })],
  });
  metrics.setGlobalMeterProvider(provider);
  return {
    meter: provider.getMeter(serviceName),
    shutdown: () => provider.shutdown(),
  };
}

export type { Meter };
