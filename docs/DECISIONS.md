# Design decisions

Each decision below lists the options considered, their pros and cons, what was chosen, and what that choice costs. Written for a mixed audience: the first paragraph of each is the plain-language version.

---

## 1. How to capture metrics without touching the 500 ms budget

**Plain version.** The connector hands each finished transaction's summary to a buffer and moves on. Something else, later, ships the buffer. If the shipping breaks, the buffer overflows and we lose some metrics, but the connector never waits.

| Option | Pros | Cons |
|---|---|---|
| **A. In-process bounded buffer, async batched publish** (chosen) | Hot-path cost is a function call and an array push (measured p99 ≈ 2 µs). Batching amortizes network cost. Hard buffer cap bounds memory and makes the failure mode explicit (drop and count). No new process per pod. | Up to one drain interval (250 ms) of events is lost if the pod dies. Lost events during an outage are lost for good. |
| B. Synchronous write per transaction (Redis `INCR`, DB insert, HTTP post) | Simplest to reason about; nothing buffered. | Puts a network round-trip on the auth path. A slow or down store becomes a slow or down authorizer. Exactly what the brief forbids. |
| C. Derive metrics from logs or traces (OTel spans → collector → tail processing) | Reuses existing instrumentation; no new code path in the connector. | Collector pipelines are built for sampling and batching on the order of seconds to minutes, not for a 2-3 s dashboard. Attributes needed for filtering would have to ride on spans at full cardinality, which the collector then has to strip for Grafana. Two different tools fighting. |
| D. Sidecar or network tap parsing ISO 8583 off the wire | Zero code in the connector. | Would have to re-implement tenant routing (BIN lookup), vendor parsing, and outcome decoding outside the component that already does all of that. Fragile, and puts PAN-bearing traffic through another process. |

**Consequence.** The platform accepts that metrics are *lossy under failure* in exchange for being *harmless under failure*. The drop counter is exported so a loss is visible, not silent.

---

## 2. Transport: Kafka

**Plain version.** Events go onto Kafka, which the platform already runs. Kafka keeps them safe for a day, so if the thing that reads them restarts, nothing is lost, and more than one thing can read them.

| Option | Pros | Cons |
|---|---|---|
| **A. Kafka (MSK)** (chosen) | Already deployed. Durable: consumers resume after restarts (which the brief says are frequent). Fan-out: real-time aggregator and OTel exporter read the same stream; a future consumer costs nothing on the connector. Partitioning by tenant gives per-tenant ordering and horizontal consumer scale. | Another hop adds ~100-500 ms of latency, well within "a few seconds". Operational weight, though it's already paid for. |
| B. Redis Streams on the existing Valkey cluster | Lower latency; already deployed. | Retention and consumer-group semantics are weaker than Kafka's for a 24-hour replay window; memory-bound; mixing a firehose with the cluster's other shared state is a noisy-neighbor risk. |
| C. Connector writes straight to Postgres/Valkey | Fewest moving parts. | Couples the connector's health to the store (see decision 1). No replay if the writer dies. Every connector pod becomes a database client doing aggregation logic. |
| D. HTTP push to the aggregator | Simple. | Aggregator becomes a single point of loss; no buffering across its restarts; load balancing and retries land in the connector. |

**Consequence.** Kafka is the durability boundary. Everything before it is best-effort and fast; everything after it is reliable and can be slow.

---

## 3. The 24-hour store: Postgres rollups (1-minute and 5-minute)

**Plain version.** Instead of keeping every transaction, we keep per-minute totals for every combination of tenant, vendor, message type, family and outcome. Any filter the operator picks is a sum over those rows. It lives in the database the platform already has.

| Option | Pros | Cons |
|---|---|---|
| **A. Postgres additive rollups, 1m + 5m** (chosen) | Arbitrary filter and drill-down is `WHERE` + `GROUP BY`; we don't pre-decide which slices matter. Rows scale with distinct combinations, not transactions (measured 25-60 rows per tenant-minute). Additive upserts make multi-replica writes commutative. Range partitions make the rolling window a `DROP TABLE`. Row-level security gives a second tenant fence. Aurora is already there. | Percentiles are histogram estimates (decision 10). A 24-hour platform-wide scan touches ~0.5M rows of the 5m table; fine today, would need a 1h tier at 10x the tenant count. |
| B. Valkey only (hashes per bucket per dimension combo) | Fastest reads; already deployed. | Every slice has to be pre-aggregated; "filter by vendor AND outcome AND family" means either a key per combination (same cardinality as Postgres, but in RAM with no SQL) or scanning keys. 24 h of that cube in memory, on a cluster shared with other state. No ad-hoc queries. Kept for the live strip only (decision 4). |
| C. Postgres raw events only, aggregate at query time | Simplest write path; exact percentiles. | 2-3M rows per day re-scanned by every operator every 3 seconds. Partition pruning helps; indexes on five dimensions don't. Works for one tenant, not for the platform view. |
| D. Prometheus/Grafana for everything, embed Grafana in the console | Mature; time-series native; already deployed. | Per-outcome-code × tenant × vendor × type × family cardinality is hostile to Prometheus. Per-tenant auth scoping inside an embedded Grafana is awkward and leaks the operator UX into a third tool. The brief positions OTel/Grafana as the >24h tier, which is where it's good. |
| E. A real OLAP/time-series store (ClickHouse, TimescaleDB, Druid) or streaming SQL (Flink, ksqlDB) | Purpose-built; would make this easy. | Not in the environment. Aurora doesn't support the Timescale extension. "Not greenfield" rules out adding a database for one dashboard. Worth revisiting if the platform ever wants sub-second analytics across weeks of data. |

**Consequence.** Two rollup tables instead of one (1m for ≤2h windows, 5m for 6h/24h) cost one extra upsert per flush and keep the long windows cheap.

---

## 4. The live strip: per-second buckets in Valkey

**Plain version.** The last five minutes at one-second resolution come from Valkey, which is fast and already shared across the platform. It's deliberately simple: totals per tenant or per vendor, not every combination.

| Option | Pros | Cons |
|---|---|---|
| **A. Valkey `HINCRBY` per (scope, second)** (chosen) | Sub-millisecond reads; TTL handles expiry; additive across replicas. Gives the "it's moving" feel the 1-minute rollups can't. | Only tenant or vendor scope, not full dimensional filtering. A second store to keep consistent. |
| B. Read the current minute from Postgres | One store. | 1-minute granularity feels static; the in-progress bucket is always partial. |
| C. Aggregator pushes to browsers directly | Lowest latency. | Ties browsers to a specific replica; breaks with horizontal scaling. |

**Consequence.** Two sources on one screen, labelled as such ("Valkey" vs "Postgres"). Operators should expect the live strip and the chart to disagree by a second or two.

---

## 5. Dashboard delivery: polling

**Plain version.** The page asks for fresh numbers every two to three seconds. The brief asks for "a few seconds behind live"; polling meets that with nothing to break.

| Option | Pros | Cons |
|---|---|---|
| **A. Poll every 2-3 s** (chosen) | Stateless API pods, trivially load-balanced, cacheable (1.5 s TTL collapses many viewers into one query). Nothing to reconnect. | N viewers × 5 endpoints every 3 s. At 50 operators that's ~80 req/s, nearly all cache hits. Not free, but far from a problem. |
| B. Server-sent events over Valkey pub/sub | Push; lower chatter; aggregator publishes a tick per flush. | Needs every API pod to subscribe and fan out; connection affinity through the load balancer; reconnect logic. The right production upgrade once viewer count justifies it. |
| C. WebSockets | Bidirectional. | Nothing here needs bidirectional. More infrastructure than SSE for no gain. |

**Consequence.** Deliberately boring. SSE is a contained follow-up (new endpoint, no data-model change).

---

## 6. Multi-tenancy: scope in the API, enforced again by Postgres RLS

**Plain version.** The API decides whose data you may see and bakes that into every query. The database checks it again. Neither trusts the web page.

| Option | Pros | Cons |
|---|---|---|
| **A. Shared tables with `tenant_id`, API scope + row-level security** (chosen) | One schema, one set of partitions, one aggregator. Platform-wide queries are the same query without the tenant predicate. RLS catches API bugs; a missing scope returns nothing. | RLS policy evaluation on every row (negligible here: `tenant_id = setting` is an index-friendly predicate). Needs a non-owner DB role for the API. |
| B. Schema or table per tenant | Hard isolation; per-tenant retention is easy. | 50 × 3 tables × 25 partitions. Platform-wide view becomes a 50-way UNION. Aggregator writes fan out. Doesn't fit "single running system serves multiple bank clients". |
| C. Separate stores per tenant | Hardest isolation. | Not how the platform works anywhere else; operational multiplication for a dashboard. |
| D. Filter in the frontend | Zero backend work. | Not isolation. |

**Consequence.** `dashboard_api` is a SELECT-only role, and every request runs inside a transaction that pins `app.scope_tenant`. Platform-level traffic (network management) sits under a reserved `platform` tenant that only the global scope sees.

---

## 7. Rolling retention: range partitions and `DROP`, not `DELETE`

**Plain version.** Old data is removed by dropping whole slices of the table, which is instant, instead of deleting rows one by one, which at millions of rows a day is slow and leaves the table bloated.

| Option | Pros | Cons |
|---|---|---|
| **A. Range partitions, pre-created ahead, dropped past retention** (chosen) | `DROP TABLE` on a partition is metadata-only: no vacuum, no bloat, no long-running delete competing with inserts. Partition pruning also makes windowed queries touch only the hours asked for. Indexes and RLS defined on the parent apply to each slice. | A maintenance job that must run (every minute from the aggregator, plus at startup, plus a CLI). A missing partition fails inserts, hence "two ahead, one behind". |
| B. `DELETE ... WHERE ts < now() - 24h` on a cron | No partition management. | At 2-3M rows/day: long deletes, dead tuples, autovacuum churn, index bloat, lock contention with the writer. |
| C. TTL in Valkey (no Postgres for 24 h) | Automatic expiry. | See decision 3B. |

**Partition widths.** Rollups: hourly, 25 retained (24 h + 1 so the oldest minute of "last 24 hours" never disappears mid-query). Raw events: 15-minute, 5 retained (75 min) so "last hour" is always complete, and each slice is ~135k rows at 150 tps, small enough that dropping one is unremarkable.

---

## 8. Delivery semantics: at-least-once, additive writes, dedupe where it's cheap

**Plain version.** If the aggregator crashes at the wrong instant, it may re-process up to one second of events. Raw transactions are deduplicated exactly. Per-minute totals for that second could be counted twice. For an operations view, that is acceptable, and it is stated.

| Option | Pros | Cons |
|---|---|---|
| **A. Commit Kafka offsets after the durable write; additive upserts; `ON CONFLICT DO NOTHING` on raw events by event id** (chosen) | No data loss on crash. Raw table is exact. Simple, fast writes. | Rollups can over-count by ≤ 1 flush interval (1 s) of events after a crash between write and commit. |
| B. Exactly-once: write offsets into Postgres in the same transaction as the rollups | Exact rollups. | Valkey and OTel writes are still outside that transaction; Kafka consumer group offsets would have to be ignored in favour of the DB's. More machinery for a dashboard. |
| C. Dedupe rollups by keeping a set of seen event ids in Valkey | Exact. | A set membership check per event per flush; memory for 24 h of ids (~3M × 36 B). Possible, not worth it. |
| D. Commit before writing (at-most-once) | Simplest. | Loses data on every crash. Worse than slight over-count. |

**Consequence.** Stated plainly in the architecture doc. Option B is the upgrade path if the rollups ever feed anything financial, which they should not.

---

## 9. Long-term (>24 h): OpenTelemetry with reduced cardinality

**Plain version.** The same numbers go to the existing Grafana, but with outcome codes grouped into five classes instead of fifteen codes, so the long-term store doesn't drown in series.

| Option | Pros | Cons |
|---|---|---|
| **A. Aggregator exports OTLP metrics (counter + histogram) with class-level outcome** (chosen) | Uses the existing collector and Grafana; same histogram boundaries as Postgres so p95 means the same thing in both. One exporter, not one per connector pod. ~1,500 series for counts. | Loses per-code and per-family detail beyond 24 h. Grafana is a second UI for the long view (the brief accepts this). |
| B. Export full-cardinality metrics | Everything available in Grafana. | tenants × vendors × 6 × 6 × 15 ≈ 100k+ series. Prometheus can, but it shouldn't. |
| C. Ship rollup rows to an object store / warehouse nightly | Full detail forever. | New pipeline; not asked for. Natural future step if analysts want history. |
| D. Each connector pod exports its own OTel metrics | No Kafka dependency for Grafana. | 50 pods × full label set; and the connector would then do histogram bookkeeping on the hot path. |

---

## 10. Percentiles: fixed-boundary histograms

**Plain version.** p95 is estimated from ten latency buckets rather than computed exactly. It is accurate to within one bucket (which are narrow around the 500 ms budget) and it works for any filter combination.

| Option | Pros | Cons |
|---|---|---|
| **A. Ten fixed bins shared by Postgres, Valkey and OTel** (chosen) | Mergeable across rows, replicas and stores. Same answer everywhere. Boundaries are dense where it matters (50-500 ms). | Interpolated, not exact. Above 2,000 ms it's "a lot". |
| B. t-digest / DDSketch per rollup row | Mergeable *and* accurate at the tails. | A binary blob per row, a library on both sides, no SQL `SUM`. Overkill for an ops view. |
| C. Exact percentiles from raw events | Exact. | Only for the last 75 minutes, and only by scanning raw rows. Used nowhere, but available for a drill-down if someone asks. |

---

## 11. Event encoding: JSON now, schema registry later

JSON on the topic keeps the prototype readable. The event is one TypeScript interface in `@nymbus/shared`, and both producer and consumer import it. In production: Avro or Protobuf with the registry MSK already supports, so the contract is versioned and a bad producer can't break the aggregator.

---

## 12. Where the aggregator lives

The brief says new backend work lives in the existing services. The aggregator is written as a worker role of that service: same repository and shared packages, its own entrypoint, deployed as its own replica set so it scales on Kafka lag and restarts without touching the auth path. In this repo it's `services/aggregator`; in the platform it's `node dist/worker.js --role=metrics-aggregator` or equivalent.

---

## Things that were considered and not built

- **Alerting.** The signals exist (`aggregator_lag_seconds`, `metrics_emitter_dropped_total`, approval-rate and p95 per tenant). Alert rules are a Grafana config task, not a design question.
- **Anomaly detection** ("this tenant's decline rate is 3σ above its baseline"). Natural next feature on top of the 5m table; out of scope for the slice.
- **Per-BIN or per-source-connection breakdowns.** The event carries `bin` and `sourceConn`; adding either as a rollup dimension is a column and a migration. Left out to keep cardinality honest until someone asks.
- **Retention beyond 24 h in Postgres.** Deliberately not; that's what OTel/Grafana is for.
