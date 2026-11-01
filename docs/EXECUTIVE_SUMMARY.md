# Executive summary

**Real-time operational visibility for the debit authorization platform**

## The problem

The platform authorizes real-time debit transactions for ~50 bank clients across five EFT vendors, around 100-150 transactions per second at peak, 2-3 million a day. Operations teams, both ours and each bank's, can see point-in-time counters and little else. When latency climbs or declines spike, nobody can see it developing, nobody can slice it by tenant, vendor, message type or outcome, and nobody can get from "something is wrong" to "these transactions" without going to logs.

## The recommendation

Add one non-blocking line to the connector, the component every transaction already passes through, that records a small summary of each completed transaction. Ship those summaries through Kafka to a worker that keeps per-minute totals in Postgres and a live tail in Valkey, and serve a dashboard inside the existing operations console that refreshes every few seconds, filters across every attribute that matters, and drills down to individual transactions. Each bank sees its own traffic; our operations team sees everything. The same numbers flow to the existing Grafana for history beyond 24 hours.

```
connector ──emit()──▶ Kafka ──▶ aggregator ──▶ Postgres (24 h, filterable)
   │ ~2 µs                          │       ──▶ Valkey (live, seconds)
   │                                └───────▶ OpenTelemetry → Grafana (>24 h)
   └── authorization path, unchanged                 ▲
                                      console ───────┘ polls every 2-3 s
```

Every piece runs on infrastructure the platform already operates. No new systems, no transaction data leaves the VPC, and the authorization path cannot be slowed or broken by anything downstream of that one line.

## Why this shape

- **It cannot hurt payments.** The connector hands the summary to an in-memory buffer and moves on; measured cost is about two microseconds per transaction against a 500 ms budget. If Kafka is slow or down the buffer fills, summaries are dropped and counted, and authorization continues. Visibility degrades; the platform does not.
- **Operators get real questions answered.** Totals are kept per minute for every combination of tenant, vendor, message type, transaction family and outcome. Any filter the operator picks is a sum over those rows, so we never have to guess in advance which slices matter. The last hour of individual transactions is kept for drill-down.
- **Two audiences, one system, no leakage.** The API resolves who is asking and pins that into the database session. Postgres row-level security enforces it on every row, so tenant isolation does not depend on the page or on a query being written correctly.
- **It survives the platform's own behaviour.** Instances restart constantly. Kafka holds the stream, so the aggregator resumes where it left off. Old data is removed by dropping whole table partitions, instant and bloat-free, instead of deleting millions of rows.
- **It has headroom.** Tested at three times the stated peak (about 420 transactions per second sustained) with zero loss and a one-second lag.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Have the connector write metrics directly to Redis or Postgres | Puts a network call on the authorization path. A slow store becomes a slow authorizer. |
| Keep everything in Redis/Valkey | Fast, but every filter combination has to be pre-computed, and 24 hours of that in memory on a shared cluster is fragile. Used only for the live tail. |
| Store raw transactions and aggregate on the fly | Simple, but a platform-wide view re-scans millions of rows every few seconds for every viewer. |
| Embed Grafana in the console | Mature tooling, but per-tenant scoping inside an embedded Grafana is awkward, the brief wants the view inside the product, and high-cardinality per-outcome metrics strain Prometheus. Grafana is the right home for the >24 h history, which is where we use it. |
| Add a purpose-built analytics engine (ClickHouse, Timescale, Flink) | Would make this easier, but the environment is not greenfield and Aurora cannot run Timescale. Not justified for one dashboard. |

## Key assumptions and scope decisions

- "A few seconds behind live" is met by a one-second aggregator write cycle and a two-to-three-second poll. Measured freshness is one to two seconds. Push delivery is a contained follow-up, not a requirement.
- Per-transaction detail is kept for the last hour; the 24-hour view is per-minute totals. Nobody needs individual transactions from 23 hours ago in a real-time console.
- Latency percentiles are estimated from histogram bins (dense around the 500 ms budget), accurate to within a bin, and identical across the console and Grafana.
- A crash at exactly the wrong moment can double-count up to one second of totals. Acceptable for an operations view; stated, not hidden.
- No card numbers or cardholder data enter the pipeline. Only the attributes operators filter by, plus amount and latency.

## What the prototype proves

- The complete path runs locally: simulated vendor traffic for 50 tenants, the connector instrumentation, Kafka, the aggregator, Postgres, Valkey, OpenTelemetry, the console, and Grafana.
- Conditions can be injected live (latency spikes, decline spikes, issuer errors, vendor outages, surges) and watched propagate to the dashboard within seconds, then drilled down to the affected transactions.
- Kafka taken down for 45 seconds: throughput and hot-path cost unchanged, nothing dropped, full recovery without intervention.
- A tenant requesting another tenant's data receives only its own, enforced at the database.
- With a full day of history loaded, the platform-wide 24-hour view answers in under a second; tenant views in tens of milliseconds.

## What production needs beyond this

Identity from the console session instead of headers; a schema registry for the event contract; container images and alert rules on the pipeline's own health signals (lag, drops), which already exist. None of these change the design.
