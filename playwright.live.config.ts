import { defineConfig, devices } from "@playwright/test";

/**
 * Opt-in: `make e2e-live` only, never CI and never part of `make e2e`. Runs
 * against a REAL sim-noirwire instance the caller already has running
 * (`SIM_LIVE_URL`, default http://localhost:4100; `SIM_LIVE_WS_URL`,
 * default derived from it). No fake-sim webServer here: this is the one
 * suite that is allowed to touch a real, if test-network-only, service.
 */
const SIM_LIVE_URL = process.env.SIM_LIVE_URL ?? "http://localhost:4100";
const SIM_LIVE_WS_URL =
  process.env.SIM_LIVE_WS_URL ?? SIM_LIVE_URL.replace(/^http/, "ws") + "/v1/stream";
const PORT = Number(process.env.PLAYWRIGHT_LIVE_PORT ?? 3101);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e/live",
  testMatch: "*.live.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx next build && npx next start --port ${PORT}`,
    env: {
      NEXT_PUBLIC_SIM_URL: SIM_LIVE_URL,
      NEXT_PUBLIC_SIM_WS_URL: SIM_LIVE_WS_URL,
      NEXT_PUBLIC_TRADING_MODE: "dev",
      NEXT_PUBLIC_NETWORK_LABEL: "TEST NETWORK",
    },
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
