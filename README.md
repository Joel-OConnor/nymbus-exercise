# Nymbus real-time operations dashboard (take-home exercise)

A near real-time operational dashboard for a multi-tenant ISO 8583 debit authorization platform: rolling 24-hour view, a few seconds behind live, filter and drill-down across tenant, vendor, message type, transaction family and outcome, with a scoped view for each bank and a platform-wide view for Nymbus operations.

Built as a thin vertical slice that runs end to end on a laptop: simulated vendor traffic → connector instrumentation → Kafka → aggregator → Postgres / Valkey / OpenTelemetry → API → Next.js console → Grafana for the long tail.

**Documents**

| | |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | What was built, how data flows, data model, multi-tenancy, capacity and failure modes |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Every design choice with the alternatives, their pros and cons, and the consequences |
| [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md) | How the underspecified brief was framed, and what's out of scope |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Operating it: commands, configuration, health checks, troubleshooting, load testing |
| [docs/DEMO.md](docs/DEMO.md) | The live demo walkthrough |
| [docs/EXECUTIVE_SUMMARY.md](docs/EXECUTIVE_SUMMARY.md) | The recommendation for a mixed technical and executive audience: problem, approach, alternatives, assumptions, evidence |
| [docs/JOURNEY.md](docs/JOURNEY.md) | Speaking notes on how the work was approached and how AI was used |
| `docs/Take-Home Exercise.pdf` | The brief |

## Quick start

```bash
cp .env.example .env
npm install
npm run infra:up        # Postgres, Valkey, Kafka, OTel collector, Prometheus, Grafana
npm run db:migrate      # schema, row-level security, initial partitions
npm run db:backfill     # optional: 24 h of synthetic history for the console's 24h view (Postgres only; Grafana fills as the stack runs)
npm run dev             # simulator + aggregator + API + console
```

- Console: http://localhost:3000
- Grafana (>24 h view): http://localhost:3001, admin / admin
- API health: http://localhost:4000/health · Simulator status: http://localhost:4100/status

See the [runbook](docs/RUNBOOK.md) for everything else.

## The design in one paragraph

The connector already touches every transaction, so it gets one extra non-blocking call: `emitter.emit(event)` pushes a ~300-byte summary onto an in-memory buffer and returns in microseconds. A background task batches the buffer onto a Kafka topic keyed by tenant; if Kafka is slow or down the buffer fills, events are dropped and counted, and the authorization path never notices. An aggregator consumes the topic and writes additive 1-minute and 5-minute rollups to Postgres (range-partitioned, dropped on a rolling schedule), per-second buckets to Valkey for the live strip, and lower-cardinality metrics to the OpenTelemetry collector for Grafana. The dashboard API resolves the caller's scope and pins it in Postgres row-level security before every query, so tenant isolation doesn't depend on the UI or on the query being right. The console polls every few seconds.

## Repository layout

```
apps/web                   Next.js 16 / React 19 console page (Tailwind, Recharts)
services/api               Dashboard API (Fastify): scoped queries, live tail, events, freshness, sim proxy
services/aggregator        Kafka consumer → Postgres rollups + raw events, Valkey live, OTel; partition maintenance
services/connector-sim     Simulated EFT vendors + connector; scenario injection; 24 h backfill
packages/metrics-emitter   The connector-side library: bounded buffer, async batched Kafka producer
packages/db                Schema (SQL), migration runner, rolling partition policy, CLI
packages/otel              OpenTelemetry metrics setup pointed at the platform collector
packages/shared            Event type, ISO 8583 reference data, histogram bins, API types
infra/                     OTel collector, Prometheus, Grafana datasource + provisioned dashboard
docker-compose.yml         Local stand-ins for Aurora, ElastiCache, MSK, collector, Grafana
docs/                      Architecture, decisions, assumptions, runbook, demo script, the brief
```

## Target environment (from the brief)

- TypeScript on Node.js; backend work lives in existing services; the console is Next.js + React
- Available: PostgreSQL (Aurora), Redis/Valkey (ElastiCache), Kafka (MSK), OpenTelemetry collector → Grafana
- Multiple container instances on EKS, scaled horizontally, restarted often
- Authorization path is latency-sensitive (sub-500 ms); metrics capture must not slow it or back-pressure it, and must fail independently
- No transaction data to external SaaS for the real-time view
- ~50 tenants, 5 EFT vendors, 100-150 tps peak, 2-3M transactions/day

## Verified on this machine

- 3x surge (≈420 tps sustained for 3 min): zero dropped events, aggregator lag 1.1-1.2 s, no slow flushes, connector hot-path cost p99 ≈ 2 µs
- Kafka stopped for 45 s: traffic generation and hot-path cost unaffected; the emitter buffered ~6,200 events with zero drops, reconnected on its own and drained them; the aggregator rebuilt its consumer and went from 77 s of lag back to 1 s within ten seconds of Kafka returning
- 24 h of history loaded (1.13M one-minute rows, 489k five-minute rows): platform-wide 24 h overview 0.88 s end to end, 24 h time series 0.31 s, 1 h views ~0.1 s, tenant-scoped 24 h 0.05 s
- Tenant isolation: a tenant-scoped request for another tenant's data returns only its own rows, through the API and directly in psql as the `dashboard_api` role
- Partitions created two periods ahead and dropped past retention by the aggregator's maintenance loop
- `npm run check` (typecheck, lint, 100 unit tests) and `npm run smoke` (35 end-to-end checks, including raw-event counts matching the rollup for the same minute) both pass against the running stack
- Graceful aggregator shutdown verified twice (SIGTERM, and a watch-mode restart): final flush written and offsets committed, no replay; catch-up after an outage verified by replaying a two-hour-old and a future-dated event plus three malformed messages

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | All four processes, colour-coded, in one terminal |
| `npm run dev:sim` / `dev:aggregator` / `dev:api` / `dev:web` | One at a time |
| `npm run db:migrate` | Apply schema and create initial partitions |
| `npm run db:backfill` | Synthesize the previous 24 h of rollups (demo prep) |
| `npm run -w packages/db partitions` | Run partition maintenance now and list partitions |
| `npm run test` | Unit tests (vitest): binning and percentiles, accumulation, query planning, scope resolution, scenario effects, the emitter's buffer contract |
| `npm run smoke` | End-to-end checks against a running stack: every API route, tenant isolation, sim round trip, CORS, collector → Prometheus → Grafana |
| `npm run typecheck` / `npm run lint` / `npm run check` | All workspaces; `check` runs typecheck, lint and tests together |
| `npm run infra:up` / `infra:down` / `infra:reset` / `infra:logs` | The compose stack |
