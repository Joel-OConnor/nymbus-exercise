/**
 * Parse an integer query parameter. Missing, empty or non-numeric values fall
 * back to the default instead of becoming NaN and surfacing as a 500 from
 * Postgres; the result is truncated and clamped to [min, max].
 */
export function intParam(raw: string | undefined, def: number, min: number, max: number): number {
  const n = raw === undefined || raw === "" ? def : Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}
