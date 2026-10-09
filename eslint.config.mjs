import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import eslintConfigPrettier from "eslint-config-prettier";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  eslintConfigPrettier,
  {
    // A leading underscore marks a parameter a stub implementation must
    // declare to satisfy an interface but does not use, e.g. the rollup
    // trading client's placeholder methods.
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "e2e/screenshots/**",
    "test-results/**",
    "playwright-report/**",
  ]),
]);

export default eslintConfig;
