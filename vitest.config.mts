import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Unit tests: pure, deterministic, no network and no browser. Runs in plain
 * Node.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.{ts,tsx}"],
  },
});
