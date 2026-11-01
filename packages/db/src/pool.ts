import pg from "pg";

const { Pool } = pg;

// Return NUMERIC and BIGINT as JS numbers. Amount sums and counts in this schema
// stay far below 2^53, and the API would otherwise have to parse strings everywhere.
pg.types.setTypeParser(1700, (v) => parseFloat(v)); // numeric
pg.types.setTypeParser(20, (v) => parseInt(v, 10)); // int8

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(connectionString: string, opts: Partial<pg.PoolConfig> = {}): pg.Pool {
  return new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...opts,
  });
}
