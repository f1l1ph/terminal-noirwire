import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { RollupTradingClient } from "@/lib/trading/rollupClient";
import type { RollupSession, TraderClientLike } from "@/lib/rollup/session";
import type { MarketInfo } from "@/lib/market-data/types";
import type { WalletIdentity } from "@/lib/trading/types";
import { RESULT_STATUS_CODE, type View } from "@/lib/rollup/sdk";

const NSOL_PERP: MarketInfo = {
  id: "NSOL-PERP",
  kind: "perp",
  base: "SOL",
  quote: "nUSD",
  tickSize: "0.010000",
  lotSize: "0.001000",
  maxLeverage: 10,
  markPrice: "150.000000",
  markPriceUpdatedAtMs: Date.now(),
  change24hPercent: 0,
  volume24h: "0",
  openInterest: "0",
};

function marketSettingsLookup(id: string): MarketInfo | undefined {
  return id === "NSOL-PERP" ? NSOL_PERP : undefined;
}

const EMPTY_VIEW = {
  header: { tag: "nwview", ready: true, marketId: 0, bump: 0 },
  owner: Keypair.generate().publicKey,
  orderKeys: [],
  seat: 0,
  resultsWritten: 0,
  results: [],
  snapshot: {
    seat: {
      owner: Keypair.generate().publicKey,
      version: 0n,
      collateral: 0n,
      spot: [],
      perp: [],
      openOrders: [],
      status: 1,
    },
    seatIndex: 0,
    marketId: 0,
    orders: [],
  },
} as unknown as View;

function fakeDeployment() {
  return {
    markets: [
      {
        numericId: 0,
        kind: "perp" as const,
        base: "SOL",
        quote: "nUSD",
        baseToken: 0,
        quoteToken: 0,
      },
    ],
    tokenSymbols: new Map([[0, "nUSD"]]),
  };
}

function fakeClient(overrides: Partial<TraderClientLike> = {}): TraderClientLike {
  return {
    view: async () => EMPTY_VIEW,
    subscribeView: () => async () => {},
    placeOrder: async () => ({
      outcome: "placed",
      result: {
        clientOrderId: 1n,
        orderSeq: 0n,
        filled: 0n,
        filledNotional: 0n,
        rested: 0n,
        cancelled: 0n,
        fee: 0n,
        kind: 1,
        status: RESULT_STATUS_CODE.filled,
        code: 0,
      },
      secret: new Uint8Array(16),
      view: EMPTY_VIEW,
      sentAt: 0,
      resultAt: 1,
    }),
    cancelOrder: async () => null,
    cancelAll: async () => null,
    syncView: async () => null,
    transferBetweenBalances: async () => null,
    ...overrides,
  };
}

function fakeSession(client: TraderClientLike, createdAtMs: number): RollupSession {
  return {
    owner: Keypair.generate(),
    orderKeyPublicKeys: [],
    client,
    mintDecimals: { decimalsOf: async () => 6 },
    deployment: () => Promise.resolve(fakeDeployment()),
    createdAtMs,
    saveKeyCheckpoint: () => {},
  };
}

const WALLET: WalletIdentity = { address: "owner-address", secretKeyHex: "aa".repeat(64) };

describe("RollupTradingClient: sign-in refresh", () => {
  it("rebuilds the session once a call throws (an expired token), then succeeds", async () => {
    let built = 0;
    const throwingClient = fakeClient({
      view: async () => {
        throw new Error("401: token expired");
      },
    });
    const workingClient = fakeClient();

    const buildSession = vi.fn(async () => {
      built += 1;
      return fakeSession(built === 1 ? throwingClient : workingClient, Date.now());
    });

    const client = new RollupTradingClient({
      simUrl: "http://sim.test",
      rollupRpcUrl: "http://rollup.test",
      rollupWsUrl: "ws://rollup.test",
      rollupPrivateUrl: "http://private.test",
      marketSettingsLookup,
      buildSession,
    });

    const state = await client.fetchState(WALLET);
    expect(state.trader).toBeDefined();
    expect(buildSession).toHaveBeenCalledTimes(2);
  });

  it("proactively rebuilds the session once it is older than the refresh window", async () => {
    let now = 0;
    let built = 0;
    const buildSession = vi.fn(async () => {
      built += 1;
      return fakeSession(fakeClient(), now);
    });

    const client = new RollupTradingClient({
      simUrl: "http://sim.test",
      rollupRpcUrl: "http://rollup.test",
      rollupWsUrl: "ws://rollup.test",
      rollupPrivateUrl: "http://private.test",
      marketSettingsLookup,
      buildSession,
      now: () => now,
    });

    await client.fetchState(WALLET);
    expect(built).toBe(1);

    now += 5 * 60 * 1000; // past the 4-minute refresh window
    await client.fetchState(WALLET);
    expect(built).toBe(2);
  });

  it("does not rebuild on every call within the refresh window", async () => {
    let now = 0;
    let built = 0;
    const buildSession = vi.fn(async () => {
      built += 1;
      return fakeSession(fakeClient(), now);
    });

    const client = new RollupTradingClient({
      simUrl: "http://sim.test",
      rollupRpcUrl: "http://rollup.test",
      rollupWsUrl: "ws://rollup.test",
      rollupPrivateUrl: "http://private.test",
      marketSettingsLookup,
      buildSession,
      now: () => now,
    });

    await client.fetchState(WALLET);
    now += 10_000;
    await client.fetchState(WALLET);
    expect(built).toBe(1);
  });
});
