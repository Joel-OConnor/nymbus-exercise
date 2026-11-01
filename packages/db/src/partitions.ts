import type { Pool } from "./pool";

/**
 * Rolling-window partition policy. Each table is RANGE-partitioned on its time
 * column into fixed-width slices; the maintenance loop pre-creates slices ahead
 * of now and drops slices whose upper bound has aged past the retention.
 */
export interface PartitionSpec {
  table: string;
  column: string;
  /** Width of one partition. */
  widthMinutes: number;
  /** How far back data must remain queryable. */
  retainMinutes: number;
  /** How many future partitions to keep pre-created so inserts never fail at a boundary. */
  aheadCount: number;
}

export const PARTITION_SPECS: PartitionSpec[] = [
  // 24h window + one spare hour so the oldest minute of "last 24h" is never mid-drop.
  { table: "txn_rollup_1m", column: "bucket_ts", widthMinutes: 60, retainMinutes: 25 * 60, aheadCount: 2 },
  { table: "txn_rollup_5m", column: "bucket_ts", widthMinutes: 60, retainMinutes: 25 * 60, aheadCount: 2 },
  // Raw events: last hour, in 15-minute slices (~135k rows each at 150 tps).
  { table: "txn_event", column: "occurred_at", widthMinutes: 15, retainMinutes: 75, aheadCount: 2 },
];

const MAINTENANCE_LOCK = 4201;

function floorTo(ms: number, widthMs: number): number {
  return Math.floor(ms / widthMs) * widthMs;
}

function partitionName(table: string, startMs: number): string {
  const d = new Date(startMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${table}_p${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}

export interface MaintenanceResult {
  created: string[];
  dropped: string[];
  skipped: boolean;
}

/**
 * Create upcoming partitions and drop expired ones for every spec. Uses a
 * try-lock so when several aggregator instances run this on the same tick only
 * one does the work; the rest return `skipped: true`.
 */
export async function maintainPartitions(pool: Pool, now: Date = new Date(), specs = PARTITION_SPECS): Promise<MaintenanceResult> {
  const result: MaintenanceResult = { created: [], dropped: [], skipped: false };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lock = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock($1) AS ok", [MAINTENANCE_LOCK]);
    if (!lock.rows[0].ok) {
      await client.query("ROLLBACK");
      result.skipped = true;
      return result;
    }

    for (const spec of specs) {
      const widthMs = spec.widthMinutes * 60_000;
      const currentStart = floorTo(now.getTime(), widthMs);

      // Create current + N ahead. Also create one behind so late-arriving
      // events just past a boundary still land somewhere.
      for (let i = -1; i <= spec.aheadCount; i++) {
        const start = currentStart + i * widthMs;
        const end = start + widthMs;
        const name = partitionName(spec.table, start);
        const res = await client.query(
          `SELECT 1 FROM pg_class WHERE relname = $1 AND relkind = 'r'`,
          [name],
        );
        if (res.rowCount) continue;
        await client.query(
          `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF ${spec.table}
             FOR VALUES FROM ('${new Date(start).toISOString()}') TO ('${new Date(end).toISOString()}')`,
        );
        result.created.push(name);
      }

      // Drop partitions whose upper bound is older than the retention horizon.
      const horizon = now.getTime() - spec.retainMinutes * 60_000;
      const children = await client.query<{ name: string; bound: string }>(
        `SELECT c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
           FROM pg_inherits i
           JOIN pg_class c ON c.oid = i.inhrelid
           JOIN pg_class p ON p.oid = i.inhparent
          WHERE p.relname = $1`,
        [spec.table],
      );
      for (const child of children.rows) {
        // bound looks like: FOR VALUES FROM ('2026-10-31 22:00:00+00') TO ('2026-10-31 23:00:00+00')
        const m = /TO \('([^']+)'\)/.exec(child.bound);
        if (!m) continue;
        const upper = new Date(m[1]).getTime();
        if (upper <= horizon) {
          await client.query(`DROP TABLE IF EXISTS ${child.name}`);
          result.dropped.push(child.name);
        }
      }
    }

    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Summarise what partitions exist; used by the API's /api/admin/partitions and the runbook. */
export async function listPartitions(pool: Pool) {
  const res = await pool.query<{ parent: string; name: string; bound: string; bytes: number; rows: number }>(
    `SELECT p.relname AS parent, c.relname AS name,
            pg_get_expr(c.relpartbound, c.oid) AS bound,
            pg_total_relation_size(c.oid) AS bytes,
            c.reltuples::bigint AS rows
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname IN ('txn_rollup_1m','txn_rollup_5m','txn_event')
      ORDER BY p.relname, c.relname`,
  );
  return res.rows;
}

/**
 * Create (without dropping) every partition needed to hold rows in [from, to].
 * Used by backfills; the regular maintenance loop will still expire these
 * partitions once they age past retention.
 */
export async function ensurePartitionsFor(pool: Pool, from: Date, to: Date, specs = PARTITION_SPECS): Promise<string[]> {
  const created: string[] = [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [MAINTENANCE_LOCK]);
    for (const spec of specs) {
      const widthMs = spec.widthMinutes * 60_000;
      for (let start = floorTo(from.getTime(), widthMs); start <= to.getTime(); start += widthMs) {
        const name = partitionName(spec.table, start);
        const exists = await client.query(`SELECT 1 FROM pg_class WHERE relname = $1 AND relkind = 'r'`, [name]);
        if (exists.rowCount) continue;
        await client.query(
          `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF ${spec.table}
             FOR VALUES FROM ('${new Date(start).toISOString()}') TO ('${new Date(start + widthMs).toISOString()}')`,
        );
        created.push(name);
      }
    }
    await client.query("COMMIT");
    return created;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
