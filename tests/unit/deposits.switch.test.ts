import { afterEach, describe, expect, it, vi } from "vitest";

const MAINNET: Record<string, string> = {
  NEXT_PUBLIC_NETWORK: "mainnet",
  NEXT_PUBLIC_SIM_URL: "https://book.noirwire.com",
  NEXT_PUBLIC_SIM_WS_URL: "wss://book.noirwire.com/v1/stream",
  NEXT_PUBLIC_TRADING_MODE: "rollup",
  NEXT_PUBLIC_SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
};

const TEST_NETWORK: Record<string, string> = {
  NEXT_PUBLIC_SIM_URL: "http://localhost:4100",
  NEXT_PUBLIC_SIM_WS_URL: "ws://localhost:4100/v1/stream",
  NEXT_PUBLIC_TRADING_MODE: "rollup",
};

const VARIABLES = [
  ...new Set([...Object.keys(MAINNET), ...Object.keys(TEST_NETWORK)]),
  "NEXT_PUBLIC_NETWORK_LABEL",
  "NEXT_PUBLIC_DEPOSITS",
  "NEXT_PUBLIC_ALLOW_UNSIGNED_DEV_MODE",
];

async function deposits(vars: Record<string, string>) {
  vi.resetModules();
  for (const name of VARIABLES) vi.stubEnv(name, "");
  for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
  return (await import("@/lib/env")).env.deposits;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("the deposits switch", () => {
  it("is off when unset, on a mainnet build and on a test build", async () => {
    expect(await deposits(MAINNET)).toBe("off");
    expect(await deposits(TEST_NETWORK)).toBe("off");
  });

  it("is off when set to off", async () => {
    expect(await deposits({ ...MAINNET, NEXT_PUBLIC_DEPOSITS: "off" })).toBe("off");
  });

  it("is on only when set to on, on a mainnet build in rollup mode", async () => {
    expect(await deposits({ ...MAINNET, NEXT_PUBLIC_DEPOSITS: "on" })).toBe("on");
  });

  it.each(["ON", "On", "true", "1", "yes", "enabled", " on", "off "])(
    "refuses the value %j rather than building as off",
    async (value) => {
      await expect(deposits({ ...MAINNET, NEXT_PUBLIC_DEPOSITS: value })).rejects.toThrow(
        /NEXT_PUBLIC_DEPOSITS/,
      );
    },
  );

  it("refuses on for a test network build", async () => {
    await expect(deposits({ ...TEST_NETWORK, NEXT_PUBLIC_DEPOSITS: "on" })).rejects.toThrow(
      /requires NEXT_PUBLIC_NETWORK=mainnet/,
    );
  });

  it("refuses on in dev trading mode", async () => {
    await expect(
      deposits({
        ...TEST_NETWORK,
        NEXT_PUBLIC_TRADING_MODE: "dev",
        NEXT_PUBLIC_ALLOW_UNSIGNED_DEV_MODE: "1",
        NEXT_PUBLIC_DEPOSITS: "on",
      }),
    ).rejects.toThrow(/NEXT_PUBLIC_DEPOSITS/);
  });
});
