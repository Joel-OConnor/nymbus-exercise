-- =============================================================================
-- Real-time traffic metrics schema
--
-- Three partitioned tables hold the rolling window. Partitions are RANGE on the
-- time column so expiry is `DROP TABLE` on a partition (instant, no bloat, no
-- vacuum) instead of `DELETE ... WHERE ts < now() - interval` (slow, churns the
-- heap, fights autovacuum at 2-3M rows/day). Partitions are created ahead of
-- time and dropped by the aggregator's maintenance loop (see partitions.ts).
-- =============================================================================

CREATE TABLE IF NOT EXISTS tenant (
  tenant_id   text PRIMARY KEY,
  name        text NOT NULL,
  vendor      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 1-minute rollups: the drill-down store for ranges up to a few hours.
-- One row per (minute, tenant, vendor, msg_type, family, outcome). Latency is
-- kept as a fixed-boundary histogram so percentiles can be summed across rows.
-- Hourly partitions, 25 retained (rolling 24h always fully covered).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS txn_rollup_1m (
  bucket_ts       timestamptz NOT NULL,
  tenant_id       text        NOT NULL,
  vendor          text        NOT NULL,
  msg_type        text        NOT NULL,
  txn_family      text        NOT NULL,
  outcome_code    text        NOT NULL,
  txn_count       bigint      NOT NULL DEFAULT 0,
  amount_sum      numeric(18,2) NOT NULL DEFAULT 0,
  latency_sum_ms  bigint      NOT NULL DEFAULT 0,
  latency_max_ms  integer     NOT NULL DEFAULT 0,
  -- histogram bins; boundaries live in @nymbus/shared LATENCY_BUCKETS_MS
  lat_b0 integer NOT NULL DEFAULT 0,  -- <= 50
  lat_b1 integer NOT NULL DEFAULT 0,  -- <= 100
  lat_b2 integer NOT NULL DEFAULT 0,  -- <= 150
  lat_b3 integer NOT NULL DEFAULT 0,  -- <= 200
  lat_b4 integer NOT NULL DEFAULT 0,  -- <= 300
  lat_b5 integer NOT NULL DEFAULT 0,  -- <= 500
  lat_b6 integer NOT NULL DEFAULT 0,  -- <= 750
  lat_b7 integer NOT NULL DEFAULT 0,  -- <= 1000
  lat_b8 integer NOT NULL DEFAULT 0,  -- <= 2000
  lat_b9 integer NOT NULL DEFAULT 0,  -- > 2000
  PRIMARY KEY (bucket_ts, tenant_id, vendor, msg_type, txn_family, outcome_code)
) PARTITION BY RANGE (bucket_ts);

CREATE INDEX IF NOT EXISTS txn_rollup_1m_tenant_ts ON txn_rollup_1m (tenant_id, bucket_ts);

-- -----------------------------------------------------------------------------
-- 5-minute rollups: same shape, 1/5 the rows. Serves the 6h and 24h views so a
-- global operator's 24h query touches ~1M rows worst case instead of ~5M.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS txn_rollup_5m (
  LIKE txn_rollup_1m INCLUDING ALL
) PARTITION BY RANGE (bucket_ts);

-- -----------------------------------------------------------------------------
-- Raw metric events: the last ~hour only, for "show me the actual transactions
-- behind that spike". 15-minute partitions, 5 retained (75 min) so "last hour"
-- is always complete. ~135k rows per partition at 150 tps.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS txn_event (
  occurred_at   timestamptz NOT NULL,
  event_id      uuid        NOT NULL,
  tenant_id     text        NOT NULL,
  vendor        text        NOT NULL,
  source_conn   text        NOT NULL,
  msg_type      text        NOT NULL,
  txn_family    text        NOT NULL,
  outcome_code  text        NOT NULL,
  amount        numeric(18,2) NOT NULL,
  latency_ms    integer     NOT NULL,
  stan          text        NOT NULL,
  bin           text        NOT NULL,
  PRIMARY KEY (occurred_at, event_id)
) PARTITION BY RANGE (occurred_at);

CREATE INDEX IF NOT EXISTS txn_event_tenant_ts ON txn_event (tenant_id, occurred_at DESC);

-- =============================================================================
-- Multi-tenancy: row-level security as the second fence behind the API.
--
-- The dashboard API connects as `dashboard_api` (SELECT only) and runs every
-- request inside a transaction that sets `app.scope_tenant` to either '*'
-- (global operator) or the caller's tenant id. If the setting is missing the
-- policy evaluates to NULL and returns nothing: fail closed. Policies on the
-- parent apply to every partition when queried through the parent.
-- =============================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dashboard_api') THEN
    CREATE ROLE dashboard_api LOGIN PASSWORD 'dashboard_api';
  END IF;
END $$;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO dashboard_api', current_database());
END $$;
GRANT USAGE ON SCHEMA public TO dashboard_api;
GRANT SELECT ON tenant, txn_rollup_1m, txn_rollup_5m, txn_event TO dashboard_api;

ALTER TABLE tenant        ENABLE ROW LEVEL SECURITY;
ALTER TABLE txn_rollup_1m ENABLE ROW LEVEL SECURITY;
ALTER TABLE txn_rollup_5m ENABLE ROW LEVEL SECURITY;
ALTER TABLE txn_event     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_scope ON tenant;
CREATE POLICY tenant_scope ON tenant FOR SELECT TO dashboard_api
  USING (current_setting('app.scope_tenant', true) = '*'
      OR tenant_id = current_setting('app.scope_tenant', true));

DROP POLICY IF EXISTS tenant_scope ON txn_rollup_1m;
CREATE POLICY tenant_scope ON txn_rollup_1m FOR SELECT TO dashboard_api
  USING (current_setting('app.scope_tenant', true) = '*'
      OR tenant_id = current_setting('app.scope_tenant', true));

DROP POLICY IF EXISTS tenant_scope ON txn_rollup_5m;
CREATE POLICY tenant_scope ON txn_rollup_5m FOR SELECT TO dashboard_api
  USING (current_setting('app.scope_tenant', true) = '*'
      OR tenant_id = current_setting('app.scope_tenant', true));

DROP POLICY IF EXISTS tenant_scope ON txn_event;
CREATE POLICY tenant_scope ON txn_event FOR SELECT TO dashboard_api
  USING (current_setting('app.scope_tenant', true) = '*'
      OR tenant_id = current_setting('app.scope_tenant', true));
