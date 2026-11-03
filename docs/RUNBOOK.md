# Runbook

How to run, operate, and troubleshoot the prototype. Everything is local; the docker-compose stack stands in for Aurora, ElastiCache, MSK and the OTel collector.

## Prerequisites

- Node.js 22+ (developed on 26), npm 10+
- Docker Desktop with Compose v2
- ~2 GB free RAM for the containers

## First run

```bash
cp .env.example .env
npm install
npm run infra:up          # postgres, valkey, kafka, otel-collector, prometheus, grafana (waits for health)
npm run db:migrate        # schema, RLS role + policies, initial partitions
npm run db:backfill       # optional: ~24 h of synthetic history so the 24h view isn't empty (~1-2 min)
npm run dev               # simulator + aggregator + API + web, one terminal, colour-coded
```

Then open http://localhost:3000. Grafana is at http://localhost:3001 (admin / admin), dashboard "Transaction metrics (long-term, via OpenTelemetry)" in the Nymbus folder.

`npm run dev` runs all four processes under `concurrently`; `Ctrl-C` stops them all. To run them separately:

| Command | Process | Port |
|---|---|---|
| `npm run dev:sim` | Connector simulator (traffic + control API) | 4100 |
| `npm run dev:aggregator` | Kafka → Postgres / Valkey / OTel | – |
| `npm run dev:api` | Dashboard API | 4000 |
| `npm run dev:web` | Next.js console | 3000 |

Each service is independent: the simulator and aggregator both ensure the Kafka topic and run migrations at start, so order does not matter.

## Checks

```bash
npm run check             # typecheck + lint + unit tests, no infrastructure needed (~20 s)
npm run smoke             # end-to-end against a running stack; exit 1 on any failure
```

Unit tests sit next to the code (`*.test.ts`) and cover the pure logic: latency binning and percentile estimation, the aggregator's additive accumulation, query planning and filter building, scope resolution, scenario effects and expiry, tenant generation, and the emitter's buffer contract (synchronous emit, drop at cap, tenant-keyed batches, requeue on failure, flush on stop) against a fake Kafka producer.

The smoke test needs `npm run dev` up for a minute or two first. It hits every API route as both roles, checks that a tenant admin cannot see or widen past their own rows, injects and cancels a scenario through the proxy the way the console does, confirms the CORS preflight the console relies on, and checks the collector, Prometheus and Grafana. One check compares the raw rows in a completed minute with that minute's rollup count, so a divergence between tiers shows up here first. Run it before a demo.

Lint covers the Node side from the root `eslint.config.mjs` (typescript-eslint recommended) and the console from `apps/web/eslint.config.mjs` (eslint-config-next).

## Configuration

All in `.env` (see `.env.example` for the full list). The ones worth knowing:

| Variable | Default | Meaning |
|---|---|---|
| `SIM_TENANTS` | 50 | Tenant population. Vendor assignment and base rates are deterministic per index. |
| `SIM_TPS_SCALE` | 1 | Multiply every tenant's base rate. 1 ≈ 137 tps steady state. |
| `KAFKA_TOPIC_PARTITIONS` | 6 | Partitions on first topic creation; caps aggregator replicas. |
| `AGG_FLUSH_MS` | 1000 | Aggregator write interval. Lower = fresher, more DB statements. |
| `AGG_PAUSE_THRESHOLD` | 50000 | Buffered events before the aggregator pauses its Kafka fetch. |
| `DATABASE_URL` | owner | Used by aggregator, simulator, migrations. |
| `API_DATABASE_URL` | `dashboard_api` role | SELECT-only, RLS-enforced. The API must not use the owner URL or RLS is bypassed. |

## Running more than one aggregator

```bash
AGG_INSTANCE_ID=agg-2 npm run dev:aggregator
```

Kafka rebalances the six partitions across the group. The freshness badge shows the replica count. Writes are additive, so replicas never conflict.

## Routine operations

### Partitions

The aggregator maintains them every minute. To inspect or force a run:

```bash
npm run -w packages/db partitions
```

Prints created/dropped partitions and a table of what exists with size and row estimates. The API exposes the same at `GET /api/admin/partitions` (platform operators only).

Policy (`packages/db/src/partitions.ts`):

| Table | Width | Retained | Pre-created |
|---|---|---|---|
| `txn_rollup_1m` | 1 h | 25 h | 2 ahead, 1 behind |
| `txn_rollup_5m` | 1 h | 25 h | 2 ahead, 1 behind |
| `txn_event` | 15 min | 75 min | 2 ahead, 1 behind |

### Topic

`txn-metrics`, 6 partitions, 24 h retention, created by whichever service starts first. To inspect:

```bash
docker compose exec kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group txn-metrics-aggregator
```

`LAG` per partition is the number of events not yet committed by the aggregator.

### Resetting

```bash
npm run infra:reset       # drops all volumes: Postgres data, Kafka log, Grafana state
npm run infra:up && npm run db:migrate
```

## Health and freshness

| Check | Where |
|---|---|
| API up | `curl localhost:4000/health` |
| Simulator up, current tps, emitter stats, hot-path cost | `curl localhost:4100/status` |
| Data freshness (seconds behind live, live aggregator replicas) | `curl -H 'x-role: global' localhost:4000/api/freshness` or the badge in the console header |
| Pipeline metrics | Grafana → "Metrics pipeline health" panel; or `curl localhost:8889/metrics \| grep -E 'emitter\|aggregator'` |

Freshness badge colours: green < 5 s, amber < 15 s, red beyond or no heartbeat.

## Troubleshooting

**Badge says "no aggregator heartbeat".** The aggregator isn't running, or Valkey is down. `npm run dev:aggregator`; check `docker compose ps valkey`.

**Freshness lag climbing, simulator shows "Kafka DOWN".** Kafka is unreachable. The connector keeps running; the emitter buffers up to 10k events, then drops and counts. When Kafka returns the emitter reconnects on its own. Dropped events are not recovered, by design. Watch `metrics_emitter_dropped_total` in Grafana.

**Freshness lag climbing, Kafka fine.** The aggregator is behind or stalled. Check its log for `flush failed` (Postgres) or `paused consumer` (Postgres slow). It retries every second and resumes from committed offsets after a restart.

**Charts show zeros for a period.** Either a real outage in the simulated traffic (an `outage` scenario) or the aggregator was down for that period and Kafka retention had expired. Gaps are rendered as zeros on purpose so silence is visible.

**Inserts failing with "no partition of relation ... found".** The maintenance loop missed a boundary (the aggregator was down for over two hours). `npm run -w packages/db partitions` fixes it; the aggregator also runs it at startup.

**A tenant admin sees nothing.** Expected if the tenant has no traffic in the window, or if `API_DATABASE_URL` points at a role without the RLS policies (fail closed). Check `GET /api/me` returns the expected scope.

**`TimeoutNegativeWarning` on startup.** kafkajs on Node 24+; harmless and filtered by `quietKafkaJsTimeoutWarning()`.

**`npm run dev` exits immediately with `EADDRINUSE` on 3000, 4000 or 4100.** A previous run (or a stray `tsx watch`) still owns the port; `concurrently -k` then stops the other three. Find and stop it, then start again:

```bash
lsof -nP -iTCP:3000 -iTCP:4000 -iTCP:4100 -sTCP:LISTEN
```

**Postgres restarted (deploy, failover, `docker compose restart postgres`).** Both the API and the aggregator log `[db] idle client error, connection discarded` once per pooled connection and keep running; the pool reconnects on the next query. A dashboard request that lands inside the restart window returns a 500 and the console's next poll succeeds. The aggregator logs `flush failed, retrying next tick` and carries on; nothing is lost because offsets are committed only after a durable write.

## Ports

| Port | Service |
|---|---|
| 3000 | Next.js console |
| 3001 | Grafana |
| 4000 | Dashboard API |
| 4100 | Simulator control API |
| 4317 / 4318 | OTel collector (gRPC / HTTP) |
| 5432 | Postgres |
| 6379 | Valkey |
| 8889 | Collector's Prometheus exporter |
| 9090 | Prometheus |
| 9092 | Kafka |

## Load testing

The simulator is the load generator. Platform-wide:

```bash
curl -X POST localhost:4100/scenarios -H 'content-type: application/json' -d '{"type":"traffic_surge","magnitude":3,"durationSec":180}'
```

3x takes the default population to ~410-430 tps. Watch the simulator log (`dropped=`, `buffer=`, `emit_p99=`), the aggregator log (`lag=`, `slow flush`), and `GET /api/freshness`. Result on a laptop: zero drops, lag 1.1-1.2 s, no slow flushes, hot-path cost p99 ≈ 2 µs. Raise `SIM_TPS_SCALE` for a sustained higher baseline.
