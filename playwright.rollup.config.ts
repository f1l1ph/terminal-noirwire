import { defineConfig, devices } from "@playwright/test";

/**
 * Opt-in: `make e2e-rollup` only, never CI and never `make e2e`/`make
 * e2e-live`. Runs against a real local MagicBlock rollup plus sim-noirwire
 * in `VENUE=rollup` mode, both already running (see README, "Running
 * against the real rollup"). This config never starts or stops that
 * network; another engineer may be using its ports (8899/7799/6699) for
 * long stretches.
 *
 * The rollup's own RPC/WS URLs and program id come from sim-noirwire's
 * `GET /v1/deployment` at runtime (src/lib/rollup/deployment.ts), not from
 * configuration here. `ROLLUP_RPC_URL`/`ROLLUP_WS_URL` below exist only so
 * the Content-Security-Policy can allow them (a static response header
 * cannot know what an async fetch will return) - they should name the same
 * addresses the deployment itself reports (the query filter, port 6699 on
 * the local stack), or the browser's connection is CSP-blocked even though
 * the deployment fetch succeeds.
 */
const SIM_ROLLUP_URL = process.env.SIM_ROLLUP_URL ?? "http://localhost:4100";
const ROLLUP_RPC_URL = process.env.ROLLUP_RPC_URL ?? "http://127.0.0.1:6699";
const ROLLUP_WS_URL = process.env.ROLLUP_WS_URL ?? "ws://127.0.0.1:6700";
const ORDERBOOK_PROGRAM_ID = process.env.ORDERBOOK_PROGRAM_ID; // falls back to the deployment's own id when unset
const PORT = Number(process.env.PLAYWRIGHT_ROLLUP_PORT ?? 3102);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e/rollup",
  testMatch: "*.rollup.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx next build && npx next start --port ${PORT}`,
    env: {
      NEXT_PUBLIC_SIM_URL: SIM_ROLLUP_URL,
      NEXT_PUBLIC_SIM_WS_URL: `${SIM_ROLLUP_URL.replace(/^http/, "ws")}/v1/stream`,
      NEXT_PUBLIC_TRADING_MODE: "rollup",
      NEXT_PUBLIC_NETWORK_LABEL: "TEST NETWORK",
      NEXT_PUBLIC_ROLLUP_RPC_URL: ROLLUP_RPC_URL,
      NEXT_PUBLIC_ROLLUP_WS_URL: ROLLUP_WS_URL,
      ...(ORDERBOOK_PROGRAM_ID ? { NEXT_PUBLIC_ORDERBOOK_PROGRAM_ID: ORDERBOOK_PROGRAM_ID } : {}),
    },
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
