import { defineConfig } from "vitest/config";

/**
 * Unit tests live next to the code they cover (`*.test.ts`) and exercise the
 * pure logic: binning and percentiles, accumulation, query planning, scope
 * resolution, scenario effects, the emitter's buffer contract. Anything that
 * needs Postgres, Kafka or Valkey is covered by `npm run smoke` against a
 * running stack instead.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "services/**/*.test.ts", "apps/web/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.next/**"],
    passWithNoTests: false,
  },
});
