# Nymbus Ops Dashboard (take-home exercise)

Prototype of a near real-time operational dashboard for a multi-tenant ISO 8583 payment platform.
See `docs/Take-Home Exercise.pdf` for the brief.

## Layout

```
apps/web          Next.js + React operations console (frontend)
services/api      Fastify/TypeScript service standing in for the existing platform backend
packages/shared   Shared types and constants
infra/            OTel collector, Prometheus, Grafana provisioning
docker-compose.yml  Local stand-ins for Aurora Postgres, ElastiCache Valkey, MSK Kafka, OTel/Grafana
docs/             Exercise brief, executive summary, assumptions, journey notes
```

## Target environment (from the brief)

- TypeScript on Node.js; frontend is Next.js + React
- PostgreSQL (Aurora), Redis/Valkey (ElastiCache), Kafka (MSK), OpenTelemetry collector -> Grafana
- Runs as horizontally scaled containers on EKS; instances restart often
- Auth path is latency-sensitive (< 500 ms); metrics capture must never block it or back-pressure it
- No transaction data to external SaaS for the real-time view
- ~100-150 tps peak, 2-3M transactions/day, ~50 tenants, 5 EFT vendors

## Getting started

```bash
cp .env.example .env
npm install
npm run infra:up      # postgres, valkey, kafka, otel-collector, prometheus, grafana
npm run dev:api       # http://localhost:4000/health
npm run dev:web       # http://localhost:3000
```

Grafana is at http://localhost:3001 (admin/admin). Stop infra with `npm run infra:down`,
wipe volumes with `npm run infra:reset`.
