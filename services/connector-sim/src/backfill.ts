/**
 * Demo prep: synthesize the previous ~24 hours of rollups so the 24-hour view
 * has history on day one. Uses the same tenant population and traffic shape as
 * the live simulator, adds a diurnal curve and three historical incidents.
 * Idempotent and safe alongside the live pipeline: any 5-minute bucket that
 * already has rows (written live, or by an earlier backfill) is skipped whole,
 * and the newest 20 minutes are always left to the aggregator. Raw events are
 * not backfilled (75 min retention).
 *
 *   npm run backfill -w services/connector-sim            # last 24 h
 *   BACKFILL_HOURS=6 npm run backfill -w services/connector-sim
 */
import { PARTITION_SPECS, createPool, ensurePartitionsFor, maintainPartitions, runMigrations } from "@nymbus/db";
import { LATENCY_BUCKETS_MS, PLATFORM_TENANT_ID, VENDORS, type Vendor } from "@nymbus/shared";
import { config } from "./config";
import { buildTenants } from "./tenants";
import { gaussian, poisson } from "./random";

const hours = Number(process.env.BACKFILL_HOURS ?? 24);
const log = (m: string) => console.log(`[backfill] ${m}`);

// Same shapes as traffic.ts, expressed as expected fractions.
const MTI: [string, number][] = [["0200", 0.78], ["0100", 0.10], ["0220", 0.04], ["0400", 0.05], ["0420", 0.03]];
const FAM: [string, number][] = [["purchase", 0.58], ["withdrawal", 0.22], ["deposit", 0.05], ["transfer", 0.10], ["payment", 0.05]];
const OUT: [string, number][] = [["00", 0.925], ["51", 0.028], ["05", 0.012], ["55", 0.010], ["61", 0.008], ["14", 0.004], ["54", 0.004], ["65", 0.003], ["57", 0.002], ["75", 0.001], ["91", 0.001], ["96", 0.0005], ["30", 0.0005], ["41", 0.0005], ["43", 0.0005]];
const AMOUNT: Record<string, number> = { purchase: 60, withdrawal: 110, deposit: 340, transfer: 410, payment: 165 }; // mean of the lognormals
const MEDIAN_MS: Record<Vendor, number> = { northgate: 110, meridian: 95, atlas: 140, cardinal: 120, summit: 160 };

/** Probability mass of lognormal(median, 0.35) per histogram bin, for a latency multiplier. */
function binProbs(median: number, mult: number): number[] {
  const mu = Math.log(median * mult);
  const sigma = 0.38;
  const cdf = (x: number) => 0.5 * (1 + erf((Math.log(x) - mu) / (sigma * Math.SQRT2)));
  const probs: number[] = [];
  let prev = 0;
  for (const b of LATENCY_BUCKETS_MS) {
    const c = cdf(b);
    probs.push(c - prev);
    prev = c;
  }
  probs.push(1 - prev);
  return probs;
}
function erf(x: number): number {
  const s = Math.sign(x);
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
function maxLatencyEstimate(mult: number, median: number): number {
  // crude max estimate: 3x the p99 of the distribution
  return Math.round(median * mult * Math.exp(0.38 * 2.33) * 1.3);
}

/** Diurnal multiplier by local hour: quiet overnight, peak early afternoon. */
function diurnal(d: Date): number {
  const h = d.getHours() + d.getMinutes() / 60;
  return 0.45 + 0.55 * Math.exp(-(((h - 13.5) / 5) ** 2));
}

interface Incident { from: number; to: number; tenantId?: string; vendor?: string; latency?: number; decline?: number; errors?: number; outage?: boolean; surge?: number }

const now = Date.now();
const H = 3_600_000;
const incidents: Incident[] = [
  { from: now - 6.2 * H, to: now - 5.8 * H, tenantId: "t034", latency: 4.5 },             // latency spike on the largest tenant ~6 h ago
  { from: now - 14.5 * H, to: now - 14.1 * H, vendor: "atlas", decline: 0.3 },            // decline spike on a vendor ~14 h ago
  { from: now - 20.3 * H, to: now - 20.0 * H, vendor: "summit", outage: true },           // vendor outage ~20 h ago
  { from: now - 9.1 * H, to: now - 8.9 * H, tenantId: "t017", errors: 0.25 },            // issuer errors ~9 h ago
  { from: now - 2.6 * H, to: now - 2.3 * H, surge: 2.2 },                                // platform-wide surge ~2.5 h ago
];

const tenants = buildTenants(config.tenantCount, config.tpsScale);
const pool = createPool(config.databaseUrl, { max: 4 });
await runMigrations(pool, log);
await maintainPartitions(pool);

const BIN_COLS = LATENCY_BUCKETS_MS.map((_, i) => `lat_b${i}`).concat([`lat_b${LATENCY_BUCKETS_MS.length}`]);
const COLS = ["bucket_ts", "tenant_id", "vendor", "msg_type", "txn_family", "outcome_code", "txn_count", "amount_sum", "latency_sum_ms", "latency_max_ms", ...BIN_COLS];

type Row = unknown[];
async function insert(table: string, rows: Row[]) {
  for (let i = 0; i < rows.length; i += 800) {
    const part = rows.slice(i, i + 800);
    const values: unknown[] = [];
    const ph: string[] = [];
    let p = 1;
    for (const r of part) {
      ph.push(`(${r.map(() => `$${p++}`).join(",")})`);
      values.push(...r);
    }
    await pool.query(`INSERT INTO ${table} (${COLS.join(",")}) VALUES ${ph.join(",")} ON CONFLICT DO NOTHING`, values);
  }
}

const probsCache = new Map<string, number[]>();
function probsFor(vendor: Vendor, mult: number) {
  const k = `${vendor}|${mult}`;
  let v = probsCache.get(k);
  if (!v) probsCache.set(k, (v = binProbs(MEDIAN_MS[vendor], mult)));
  return v;
}

function rowsForBucket(bucket: Date, widthMin: number): Row[] {
  const rows: Row[] = [];
  const t = bucket.getTime();
  const dn = diurnal(bucket);
  for (const ten of tenants) {
    let latMult = 1, decline = 0, errors = 0, surge = 1, outage = false;
    for (const inc of incidents) {
      if (t < inc.from || t >= inc.to) continue;
      if (inc.tenantId && inc.tenantId !== ten.tenantId) continue;
      if (inc.vendor && inc.vendor !== ten.vendor) continue;
      if (inc.latency) latMult *= inc.latency;
      if (inc.decline) decline += inc.decline;
      if (inc.errors) errors += inc.errors;
      if (inc.surge) surge *= inc.surge;
      if (inc.outage) outage = true;
    }
    if (outage) continue;
    const expected = ten.baseTps * 60 * widthMin * dn * surge;
    const probs = probsFor(ten.vendor, latMult);
    const maxMs = maxLatencyEstimate(latMult, MEDIAN_MS[ten.vendor]);
    for (const [mti, wm] of MTI) {
      const fams = mti === "0100" ? [["purchase", 0.9], ["withdrawal", 0.1]] as [string, number][] : FAM;
      for (const [fam, wf] of fams) {
        for (const [code, wo] of OUT) {
          let w = wo;
          if (mti === "0220" || mti === "0400" || mti === "0420") w = code === "00" ? 0.985 : code === "96" ? 0.015 : 0;
          else if (errors && (code === "91" || code === "96")) w = wo * (1 - decline - errors) + errors * (code === "91" ? 0.7 : 0.3);
          else if (decline && (code === "51" || code === "05" || code === "61")) w = wo * (1 - decline - errors) + decline * (code === "51" ? 0.6 : code === "05" ? 0.25 : 0.15);
          else w = wo * (1 - decline - errors);
          const lambda = expected * wm * wf * w;
          if (lambda < 0.15) continue;
          const n = poisson(lambda);
          if (n === 0) continue;
          const bins = probs.map((pr) => Math.round(pr * n));
          const diff = n - bins.reduce((a, b) => a + b, 0);
          bins[1] = Math.max(0, bins[1] + diff);
          const avgMs = MEDIAN_MS[ten.vendor] * latMult * 1.07;
          const latSum = Math.round(n * avgMs * (1 + 0.05 * gaussian()));
          rows.push([bucket, ten.tenantId, ten.vendor, mti, fam, code, n, (n * AMOUNT[fam] * (1 + 0.1 * gaussian())).toFixed(2), latSum, maxMs, ...bins]);
        }
      }
    }
  }
  // network-management heartbeats: one per vendor every 5 s
  for (const v of Object.keys(VENDORS)) {
    const n = 12 * widthMin;
    rows.push([bucket, PLATFORM_TENANT_ID, v, "0800", "network", "00", n, "0.00", n * 12, 40, n, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  }
  return rows;
}

const end = Math.floor((now - 20 * 60_000) / 300_000) * 300_000; // 5-min aligned; leave the last 20 min to the live pipeline
const start = end - hours * H;
log(`${tenants.length} tenants, ${hours} h, ${new Date(start).toISOString()} → ${new Date(end).toISOString()}`);
const rollupSpecs = PARTITION_SPECS.filter((s) => s.table.startsWith("txn_rollup"));
const made = await ensurePartitionsFor(pool, new Date(start), new Date(end), rollupSpecs);
if (made.length) log(`created ${made.length} historical partitions`);
const populated = new Set(
  (await pool.query<{ bucket_ts: Date }>("SELECT DISTINCT bucket_ts FROM txn_rollup_5m WHERE bucket_ts >= $1 AND bucket_ts < $2", [new Date(start), new Date(end)])).rows.map((r) => r.bucket_ts.getTime()),
);
if (populated.size) log(`skipping ${populated.size} five-minute buckets that already hold data`);
let rows1 = 0, rows5 = 0;
const t0 = Date.now();
for (let t = start; t < end; t += 5 * 60_000) {
  if (populated.has(t)) continue;
  const batch1: Row[] = [];
  for (let m = 0; m < 5; m++) batch1.push(...rowsForBucket(new Date(t + m * 60_000), 1));
  const batch5 = rowsForBucket(new Date(t), 5);
  await Promise.all([insert("txn_rollup_1m", batch1), insert("txn_rollup_5m", batch5)]);
  rows1 += batch1.length;
  rows5 += batch5.length;
  if ((t - start) % H === 0) log(`${new Date(t).toISOString()} rows_1m=${rows1} rows_5m=${rows5} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
log(`done: rows_1m=${rows1} rows_5m=${rows5} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
await pool.end();
