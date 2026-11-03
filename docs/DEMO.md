# Demo script

A walkthrough for the live presentation. About 15 minutes including questions. Everything runs locally; nothing touches the network.

## Before the meeting

```bash
npm run infra:up && npm run db:migrate
npm run db:backfill        # 24 h of plausible history with incidents at ~2.5 h, 6 h, 9 h, 14 h and 20 h ago
npm run dev
npm run smoke              # in a second terminal, once traffic is flowing: 31 checks, all should PASS
```

Let it run at least 15 minutes beforehand so the raw-event table and the live strip have real data. Open two browser tabs: the console at http://localhost:3000 and Grafana at http://localhost:3001 (admin/admin, Nymbus folder). Keep a terminal visible with `npm run dev` output for the "what's happening underneath" moments.

## 1. The platform view (2 min)

Start as **Platform operator**, range **1 hour**.

- Point at the freshness badge: "0.9 s behind live". That number is computed from aggregator heartbeats, not assumed.
- KPI row: throughput, approval rate, p95 against the 500 ms budget, declines, system errors, volume.
- Live strip: last five minutes at five-second resolution, from Valkey. Chart below: one-minute rollups from Postgres. Two stores, labelled.
- Breakdowns: outcome, family, message type, vendor, top tenants. Click **Atlas Pay** in the vendor list: everything re-scopes. Click it again to clear.
- Switch to **24 hours**: the chart moves to 5-minute rollups. The backfilled incidents are visible as blips. Mention: same query shape, different table.

## 2. The tenant view (1 min)

Switch to **Tenant admin**, pick any tenant.

- Everything narrows to that institution. No tenant filter, no top-tenants panel.
- Say: this isn't the UI hiding things. The API pins the scope and Postgres row-level security enforces it. Optional proof in a terminal:

```bash
curl -s -H 'x-role: tenant' -H 'x-tenant-id: t001' 'localhost:4000/api/overview?range=1h&tenantId=t002' | head -c 300
```

The `tenantId=t002` parameter is ignored; the totals are t001's.

## 3. Something goes wrong (5 min)

Back to **Platform operator**, range **15 min**, scroll to the simulator panel.

**Latency spike.** Click *Latency spike · t001*. Within ~5 seconds the live p95 line for the platform twitches; it's one tenant in fifty. Switch to tenant t001 and the p95 tile goes red at 500+ ms, the latency chart climbs past the budget line, and the outcome list grows a "91 Issuer unavailable" row (the connector times out the issuer leg past 2.5 s). Click the newest bar on the traffic chart: the transactions table shows the actual slow transactions with their STANs. That's the drill-down from "something is wrong" to "these transactions".

**Decline spike on a vendor.** Platform view, click *Decline spike · Atlas Pay*. Approval rate drops; the vendor breakdown shows Atlas Pay's p95 unchanged but its approval share falling; the outcome list shows 51/05/61 rising. Click *51 · Insufficient funds* to filter, then click a bar to see the declined transactions.

**Vendor outage.** Click *Outage · Summit EFT*. In the vendor breakdown Summit's count stops growing; on the 15-minute chart the bars shrink by Summit's share; filter by vendor Summit and the live strip flatlines to zero. Silence is rendered, not hidden.

**Surge.** Click *3× surge · platform-wide*. The simulator panel shows ~420 tps. Watch the aggregator terminal: lag stays ~1 s, no slow flushes; the simulator line shows `dropped=0` and `emit_p99=0.002ms`. That's the "150 tps and 50 tenants" question answered with margin.

Cancel all scenarios from the panel.

## 4. The subsystem fails, the platform doesn't (3 min)

This is the constraint the brief cares most about. In a terminal:

```bash
docker compose stop kafka
```

- Simulator terminal: `kafka=DOWN`, `buffer=` climbing by ~140 per second, `emit_p99` still microseconds, `tps` unchanged. The connector did not notice.
- Console: freshness badge turns amber, then red. The live strip stops advancing. Charts keep the data they had.
- Wait ~70 seconds and `dropped=` starts climbing: the buffer is full, events are being discarded and counted.

```bash
docker compose start kafka
```

- Simulator reconnects on its own, buffer drains, `dropped` stops. Badge goes green. The gap in the chart is real and permanent: metrics were lost, payments were not.
- Grafana: the "Metrics pipeline health" panel shows the drop as a spike on `dropped/s`.

## 5. Beyond 24 hours (1 min)

Grafana tab. Same throughput, outcome mix and p95, by tenant and vendor, from the OTel collector. Point out the outcome is by *class* here, not by code: cardinality is the cost of long retention, and this is where it's paid. The console is for "now"; this is for "last Tuesday".

## 6. What's underneath (optional, 2 min)

If asked how it holds together:

- `packages/metrics-emitter/src/emitter.ts`: the whole connector-side change. `emit()` is eleven lines.
- `packages/db/sql/001_schema.sql`: three partitioned tables, histogram columns, RLS policies.
- `services/aggregator/src/index.ts`: consume, accumulate, flush, commit; partitions every minute.
- `services/api/src/queries.ts`: `GROUPING SETS` for the overview; gap-filled series.
- `docs/DECISIONS.md` for every alternative considered.

## Things that can go sideways

- **Tenant switcher list empty**: the API couldn't reach Postgres. `docker compose ps`.
- **Scenario buttons do nothing**: simulator not running (`npm run dev:sim`) or the API can't reach :4100.
- **24h view empty**: backfill wasn't run. The last hour is still fine.
- **Grafana shows "No data"**: Prometheus needs ~30 s of scrapes after the aggregator starts.
