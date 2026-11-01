import { createPool } from "./pool";
import { runMigrations } from "./migrate";
import { maintainPartitions, listPartitions } from "./partitions";

const url = process.env.DATABASE_URL ?? "postgres://nymbus:nymbus@localhost:5432/nymbus";
const cmd = process.argv[2];

const pool = createPool(url, { max: 2 });
try {
  if (cmd === "migrate") {
    await runMigrations(pool, console.log);
    const r = await maintainPartitions(pool);
    console.log(`migrations complete; partitions created=${r.created.length} dropped=${r.dropped.length}`);
  } else if (cmd === "partitions") {
    const r = await maintainPartitions(pool);
    console.log(`created=${r.created.join(",") || "-"} dropped=${r.dropped.join(",") || "-"}`);
    console.table(await listPartitions(pool));
  } else {
    console.error("usage: cli.ts <migrate|partitions>");
    process.exit(2);
  }
} finally {
  await pool.end();
}
