import pg from "pg";

const { Pool } = pg;

// Return NUMERIC and BIGINT as JS numbers. Amount sums and counts in this schema
// stay far below 2^53, and the API would otherwise have to parse strings everywhere.
pg.types.setTypeParser(1700, (v) => parseFloat(v)); // numeric
pg.types.setTypeParser(20, (v) => parseInt(v, 10)); // int8

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(connectionString: string, opts: Partial<pg.PoolConfig> = {}): pg.Pool {
  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...opts,
  });

  // An idle client that loses its connection (Postgres restart, failover, network
  // blip) emits 'error' on the pool. Without a listener Node treats that as an
  // unhandled 'error' event and exits the process. pg-pool already discards the
  // dead client; all we need to do is note it and let the next query reconnect.
  pool.on("error", (err) => {
    console.error(`[db] idle client error, connection discarded: ${err.message}`);
  });

  return pool;
}
