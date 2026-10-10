import { defineConfig, devices } from "@playwright/test";

/**
 * Opt-in: `make e2e-devnet` only, never CI and never any other `make e2e*`.
 * Runs against the real order book live on Solana devnet, through a
 * sim-noirwire already running in `VENUE=rollup` mode pointed at devnet
 * (another engineer's machine or process - this config never starts, stops
 * or reconfigures it). The rollup's own RPC/WS URLs come from sim-noirwire's
 * `GET /v1/deployment` at runtime; `ROLLUP_RPC_URL`/`ROLLUP_WS_URL` below
 * exist only so the Content-Security-Policy can allow them ahead of that
 * fetch, and default to MagicBlock's hosted devnet endpoint
 * (https://devnet-tee.magicblock.app) - the exact value `/v1/deployment`
 * reports on devnet, confirmed by hand before writing this config.
 *
 * Reuses the wallet persisted in `e2e/.devnet-wallet.json` (git-ignored)
 * across runs: devnet seats are scarce (100 new accounts/day, one funding
 * grant per address), so this suite creates a wallet once, ever, and every
 * later run signs in with the same one instead.
 */
const SIM_DEVNET_URL = process.env.DEVNET_SIM_URL ?? "http://localhost:4100";
const ROLLUP_RPC_URL = process.env.ROLLUP_RPC_URL ?? "https://devnet-tee.magicblock.app";
const ROLLUP_WS_URL = process.env.ROLLUP_WS_URL ?? "wss://devnet-tee.magicblock.app";
const ORDERBOOK_PROGRAM_ID = process.env.ORDERBOOK_PROGRAM_ID; // falls back to the deployment's own id when unset
// 3100 (not 3102, used by e2e-rollup, or a fresh port): the devnet-pointed
// sim-noirwire instance's own ALLOWED_ORIGINS already allows this one and
// 3000 (confirmed by hand - `curl -H "Origin: ..."` and reading the
// `access-control-allow-origin` response header), neither of which this
// repo controls. Pick a different port only after confirming the same way.
const PORT = Number(process.env.PLAYWRIGHT_DEVNET_PORT ?? 3100);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e/devnet",
  testMatch: "*.devnet.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Devnet round trips run a few hundred ms to a few seconds, not the
  // local stack's tens of milliseconds - every timeout here is generous
  // accordingly.
  timeout: 180_000,
  expect: { timeout: 60_000 },
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 60_000,
    navigationTimeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx next build && npx next start --port ${PORT}`,
    env: {
      NEXT_PUBLIC_SIM_URL: SIM_DEVNET_URL,
      NEXT_PUBLIC_SIM_WS_URL: `${SIM_DEVNET_URL.replace(/^http/, "ws")}/v1/stream`,
      NEXT_PUBLIC_TRADING_MODE: "rollup",
      NEXT_PUBLIC_NETWORK_LABEL: "DEVNET",
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
