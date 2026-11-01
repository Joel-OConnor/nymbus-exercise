# Assumptions and scope decisions

The brief is intentionally underspecified. These are the calls made to turn it into something buildable, and what they rule in or out.

## About the traffic

1. **The connector knows the tenant.** BIN-to-tenant routing happens before or inside the connector, so the metric event carries `tenantId` directly. We never re-derive it downstream.
2. **The attributes operators slice by are:** tenant, EFT vendor, source connection, message type (MTI), transaction family (from the processing code), outcome code (DE39), amount and end-to-end latency. Nothing else is captured. Adding a dimension is a column and a migration; it was kept to these to keep cardinality honest.
3. **Message types** modelled: 0100 authorization request, 0200 financial request, 0220 financial advice, 0400 reversal request, 0420 reversal advice, 0800 network management. **Families:** purchase, withdrawal, deposit, transfer, payment, plus "network" for 0800s. **Outcome codes:** fifteen common DE39 values grouped into five classes (approved, soft decline, hard decline, system error, format error). The groupings are an operator's triage view, not an ISO definition.
4. **Network-management messages are platform traffic, not tenant traffic.** They're attributed to a reserved `platform` tenant that only the global scope sees.
5. **Latency** means connector end-to-end: vendor request received to vendor response written. The 500 ms budget in the brief is applied as the p95 threshold throughout.
6. **No PAN or cardholder data** goes into the metrics pipeline. The event carries the issuing BIN (first six digits) and the STAN for correlation; both are already in operational logs today.
7. **Volumes** per the brief: ~50 tenants, 5 vendors, 2 tps typical per tenant, ~15 tps for the largest, 100-150 tps platform peak, 2-3M/day. The simulator's default population lands at ~137 tps and 3 "large" tenants. Designed and tested headroom is 3x.

## About the environment

8. **"New backend work lives in the existing services"** is read as: same codebase, same deployment pipeline, possibly separate processes. The aggregator is a worker role, not a new system. The metrics emitter is a library the connector imports.
9. **Kafka, Postgres, Valkey and the OTel collector are available and shared**, so this design adds load to them but no new infrastructure. Topic creation, schema migration and partition maintenance are owned by the services that need them.
10. **Instances restart often** (deploys, scaling, crashes). Nothing holds state that can't be rebuilt from Kafka within its retention; losing up to 250 ms of unflushed connector events on a restart is accepted.
11. **The operations console already authenticates users and knows their tenant.** The prototype substitutes two headers for that session; the API's scope resolution is the only place that would change.
12. **"Inside the existing product's operational console"** rules out embedding Grafana for the real-time view. Grafana is used, via OTel, only for the >24h view, which the brief explicitly allows.
13. **"No transaction data to external SaaS"** is satisfied by construction: every store is in-VPC and already used for other platform data.

## About the dashboard

14. **"A few seconds behind live"** is met by polling every 2-3 s plus an aggregator flush every 1 s. Measured end-to-end freshness is ~1-2 s. Push (SSE) is a follow-up, not a requirement.
15. **"Rolling 24-hour view"** means the last 24 hours from now, at 1-minute resolution for short windows and 5-minute for long ones, with exact per-transaction drill-down for the last hour only. Nobody needs per-transaction rows from 23 hours ago in a real-time console; that's what logs and the long-term store are for.
16. **Percentiles are histogram estimates** with bins dense around the budget (50-500 ms). Good to within one bin; the same bins are used in Postgres, Valkey and OTel so numbers agree across views.
17. **Slight over-counting after an aggregator crash** (≤ 1 s of events) is acceptable for an operations view and is documented. Raw transactions are exactly deduplicated.
18. **Two audiences, one page.** The same dashboard serves tenant admins and platform operators; the scope changes what the API will return, and the page adapts (no tenant filter or top-tenants panel for a tenant admin).

## Deliberately out of scope

- Alert rules (the signals exist; wiring alerts is configuration).
- Anomaly detection and baselining.
- Per-BIN, per-source-connection or per-amount-band breakdowns (easy to add; left out until asked).
- Real ISO 8583 parsing. The simulator produces already-decoded events, which is what the real connector would hand the emitter.
- Authentication, authorization UI, audit logging for the console.
- Production packaging (Docker images, Helm, CI). The code is structured for it; it wasn't the point of the exercise.
