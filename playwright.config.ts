import { defineConfig, devices } from "@playwright/test";
import { FAKE_SIM_PORT, FAKE_SIM_URL, FAKE_SIM_WS_URL } from "./e2e/support/fakeSim";

// The suite runs against its own production build on its own port, built
// with NEXT_PUBLIC_SIM_URL / NEXT_PUBLIC_SIM_WS_URL pointing at the fake sim
// this config also starts (e2e/fake-sim/server.mts). A developer's own
// .env.local may name a different service; process env overrides it here.
const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 3100);
const BASE_URL = `http://localhost:${PORT}`;

const BUILD_ENV = {
  NEXT_PUBLIC_SIM_URL: FAKE_SIM_URL,
  NEXT_PUBLIC_SIM_WS_URL: FAKE_SIM_WS_URL,
  NEXT_PUBLIC_TRADING_MODE: "dev",
  NEXT_PUBLIC_NETWORK_LABEL: "TEST NETWORK",
};

export default defineConfig({
  testDir: "./e2e",
  testMatch: "*.spec.ts",
  // e2e/live/*.live.spec.ts needs a real sim-noirwire instance; it runs
  // only through `make e2e-live` (playwright.live.config.ts), never here.
  testIgnore: "live/**",
  // Serial on purpose: the specs share one app server and one fake sim,
  // which each spec resets and steers.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: {
    timeout: 20_000,
  },
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: `node e2e/fake-sim/server.mts ${FAKE_SIM_PORT}`,
      url: `${FAKE_SIM_URL}/v1/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `npx next build && npx next start --port ${PORT}`,
      env: BUILD_ENV,
      url: BASE_URL,
      reuseExistingServer: false,
      timeout: 300_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
