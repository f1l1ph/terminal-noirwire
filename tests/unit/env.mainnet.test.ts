import { afterEach, describe, expect, it, vi } from "vitest";
import { MAINNET_PINS } from "@/lib/rollup/pins";

const PRODUCTION: Record<string, string> = {
  NEXT_PUBLIC_NETWORK: "mainnet",
  NEXT_PUBLIC_SIM_URL: "https://book.noirwire.com",
  NEXT_PUBLIC_SIM_WS_URL: "wss://book.noirwire.com/v1/stream",
  NEXT_PUBLIC_TRADING_MODE: "rollup",
  NEXT_PUBLIC_NETWORK_LABEL: "MAINNET",
  NEXT_PUBLIC_ROLLUP_RPC_URL: "https://mainnet-tee.magicblock.app",
  NEXT_PUBLIC_ROLLUP_WS_URL: "wss://mainnet-tee.magicblock.app",
  NEXT_PUBLIC_ORDERBOOK_PROGRAM_ID: "BrUoDsreaeXWypVxh6LoGseqwB4TZVJZBxvhfxXprvwP",
};

const CONFIG_VARIABLES = [...Object.keys(PRODUCTION), "NEXT_PUBLIC_ALLOW_UNSIGNED_DEV_MODE"];

async function loadEnv(vars: Record<string, string>) {
  vi.resetModules();
  for (const name of CONFIG_VARIABLES) vi.stubEnv(name, "");
  for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
  return (await import("@/lib/env")).env;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("mainnet configuration", () => {
  it("accepts the production environment and resolves to the pins", async () => {
    const env = await loadEnv(PRODUCTION);
    expect(env.network).toBe("mainnet");
    expect(env.orderbookProgramIdOverride).toBe(MAINNET_PINS.programId);
    expect(env.rollupRpcUrlOverride).toBe(MAINNET_PINS.rollupRpcUrl);
    expect(env.rollupWsUrlOverride).toBe(MAINNET_PINS.rollupWsUrl);
  });

  it("takes the pins when the overrides and the label are left unset", async () => {
    const env = await loadEnv({
      NEXT_PUBLIC_NETWORK: "mainnet",
      NEXT_PUBLIC_SIM_URL: PRODUCTION.NEXT_PUBLIC_SIM_URL,
      NEXT_PUBLIC_SIM_WS_URL: PRODUCTION.NEXT_PUBLIC_SIM_WS_URL,
      NEXT_PUBLIC_TRADING_MODE: "rollup",
    });
    expect(env.networkLabel).toBe("MAINNET");
    expect(env.orderbookProgramIdOverride).toBe(MAINNET_PINS.programId);
  });

  it("refuses dev mode", async () => {
    await expect(loadEnv({ ...PRODUCTION, NEXT_PUBLIC_TRADING_MODE: "dev" })).rejects.toThrow(
      /requires NEXT_PUBLIC_TRADING_MODE=rollup/,
    );
  });

  it("refuses the unsigned dev flag", async () => {
    await expect(
      loadEnv({ ...PRODUCTION, NEXT_PUBLIC_ALLOW_UNSIGNED_DEV_MODE: "1" }),
    ).rejects.toThrow(/NEXT_PUBLIC_ALLOW_UNSIGNED_DEV_MODE/);
  });

  it.each(["TEST NETWORK", "Testnet", "DEVNET", "DEMO", "PAPER", "mainnet"])(
    "refuses the label %s",
    async (label) => {
      await expect(loadEnv({ ...PRODUCTION, NEXT_PUBLIC_NETWORK_LABEL: label })).rejects.toThrow(
        /NEXT_PUBLIC_NETWORK_LABEL/,
      );
    },
  );

  it("refuses a program id other than the pin", async () => {
    await expect(
      loadEnv({
        ...PRODUCTION,
        NEXT_PUBLIC_ORDERBOOK_PROGRAM_ID: "11111111111111111111111111111111",
      }),
    ).rejects.toThrow(/NEXT_PUBLIC_ORDERBOOK_PROGRAM_ID/);
  });

  it.each(["https://devnet-tee.magicblock.app", "https://mainnet-tee.magicblock.app/"])(
    "refuses the rollup RPC URL %s",
    async (url) => {
      await expect(loadEnv({ ...PRODUCTION, NEXT_PUBLIC_ROLLUP_RPC_URL: url })).rejects.toThrow(
        /NEXT_PUBLIC_ROLLUP_RPC_URL/,
      );
    },
  );

  it.each(["wss://devnet-tee.magicblock.app", "wss://mainnet-tee.magicblock.app/"])(
    "refuses the rollup websocket URL %s",
    async (url) => {
      await expect(loadEnv({ ...PRODUCTION, NEXT_PUBLIC_ROLLUP_WS_URL: url })).rejects.toThrow(
        /NEXT_PUBLIC_ROLLUP_WS_URL/,
      );
    },
  );

  it.each(["mainet", "Mainnet", "mainnet ", "MAINNET"])(
    "refuses the network name %j",
    async (name) => {
      await expect(loadEnv({ ...PRODUCTION, NEXT_PUBLIC_NETWORK: name })).rejects.toThrow(
        /network/,
      );
    },
  );
});

describe("a build without NEXT_PUBLIC_NETWORK", () => {
  it("resolves as a test build with the test defaults and no pinned values", async () => {
    const env = await loadEnv({
      NEXT_PUBLIC_SIM_URL: "http://localhost:4100",
      NEXT_PUBLIC_SIM_WS_URL: "ws://localhost:4100/v1/stream",
    });
    expect(env).toMatchObject({
      network: "test",
      tradingMode: "dev",
      networkLabel: "TEST NETWORK",
      rollupRpcUrlOverride: undefined,
      rollupWsUrlOverride: undefined,
      orderbookProgramIdOverride: undefined,
    });
  });

  it("keeps accepting a devnet override and a test label", async () => {
    const env = await loadEnv({
      NEXT_PUBLIC_SIM_URL: "http://localhost:4100",
      NEXT_PUBLIC_SIM_WS_URL: "ws://localhost:4100/v1/stream",
      NEXT_PUBLIC_TRADING_MODE: "rollup",
      NEXT_PUBLIC_ROLLUP_RPC_URL: "https://devnet-tee.magicblock.app",
    });
    expect(env.rollupRpcUrlOverride).toBe("https://devnet-tee.magicblock.app");
  });
});
