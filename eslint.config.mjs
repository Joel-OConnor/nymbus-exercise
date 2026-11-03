import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

/**
 * Lint for the Node side of the monorepo (packages/*, services/*). The Next.js
 * app keeps its own config in apps/web, which eslint-config-next provides.
 */
export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "apps/**", "**/.next/**", "**/dist/**", "infra/**", "scripts/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["packages/**/*.ts", "services/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": "off",
    },
  },
  {
    // Tests reach into private members on purpose.
    files: ["**/*.test.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
