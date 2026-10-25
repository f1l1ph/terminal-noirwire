import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { keypairOwnerSigner } from "@/lib/wallet/ownerSigner";
import { RollupTradingClient } from "@/lib/trading/rollupClient";
import { SessionAuthError, type RollupSession, type TraderClientLike } from "@/lib/rollup/session";
import type { PublicDeployment } from "@/lib/rollup/deployment";
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

const FAKE_DEPLOYMENT: PublicDeployment = {
  network: "localnet",
  programId: Keypair.generate().publicKey.toBase58(),
  solanaRpcUrl: "http://127.0.0.1:8899",
  rollupRpcUrl: "http://127.0.0.1:6699",
  rollupWsUrl: "ws://127.0.0.1:6700",
  exchange: Keypair.generate().publicKey.toBase58(),
  stats: Keypair.generate().publicKey.toBase58(),
  markets: [
    {
      marketId: 0,
      symbol: "NSOL-PERP",
      kind: "perp",
      market: Keypair.generate().publicKey.toBase58(),
      tape: Keypair.generate().publicKey.toBase58(),
      priceFeed: Keypair.generate().publicKey.toBase58(),
      baseToken: null,
      quoteToken: { symbol: "nUSD", mint: Keypair.generate().publicKey.toBase58(), decimals: 6 },
      baseDecimals: 9,
      quoteDecimals: 6,
      lotSize: "1000000",
      tick: "100",
    },
  ],
};

/** 0.3.1: cancelOrder/cancelAll/syncView/transferBetweenBalances no longer return null on timeout (they throw `OutcomeUnknown` instead), so every fake here returns an ordinary successful result by default. */
const FAKE_SUCCESS = {
  clientOrderId: 1n,
  orderSeq: 0n,
  filled: 0n,
  filledNotional: 0n,
  rested: 0n,
  cancelled: 0n,
  fee: 0n,
  kind: 3,
  status: RESULT_STATUS_CODE.filled,
  code: 0,
  sentAt: 0,
  resultAt: 1,
};

function fakeClient(overrides: Partial<TraderClientLike> = {}): TraderClientLike {
  return {
    view: async () => EMPTY_VIEW,
    subscribeView: () => async () => {},
    placeOrder: async () => ({
      outcome: "placed",
      clientOrderId: 1n,
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
    cancelOrder: async () => FAKE_SUCCESS,
    cancelAll: async () => FAKE_SUCCESS,
    syncView: async () => FAKE_SUCCESS,
    transferBetweenBalances: async () => FAKE_SUCCESS,
    ...overrides,
  };
}

function fakeSession(client: TraderClientLike, tokenExpiresAtMs: number): RollupSession {
  return {
    owner: keypairOwnerSigner(Keypair.generate()),
    orderKeyPublicKeys: [],
    client,
    deployment: FAKE_DEPLOYMENT,
    tokenIndexBySymbol: new Map([["nUSD", 0]]),
    collateralToken: { mint: Keypair.generate().publicKey, custodyNonce: 0n },
    gate: Keypair.generate().publicKey,
    tokenExpiresAtMs,
    saveKeyCheckpoint: () => {},
    close: () => {},
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

const WALLET: WalletIdentity = { address: "owner-address", secretKeyHex: "aa".repeat(64) };

describe("RollupTradingClient: sign-in refresh", () => {
  it("rebuilds the session once after a typed sign-in failure, then succeeds", async () => {
    let built = 0;
    const buildSession = vi.fn(async () => {
      built += 1;
      if (built === 1) throw new SessionAuthError(new Error("401: token expired"));
      return fakeSession(fakeClient(), Date.now() + 30 * DAY_MS);
    });

    const client = new RollupTradingClient({
      simUrl: "http://sim.test",
      marketSettingsLookup,
      buildSession,
    });

    const state = await client.fetchState(WALLET);
    expect(state.trader).toBeDefined();
    expect(buildSession).toHaveBeenCalledTimes(2);
  });

  it("rebuilds the session, and so signs in again, only once its token is about to lapse", async () => {
    let now = 0;
    let built = 0;
    const buildSession = vi.fn(async () => {
      built += 1;
      return fakeSession(fakeClient(), now + 30 * DAY_MS);
    });

    const client = new RollupTradingClient({
      simUrl: "http://sim.test",
      marketSettingsLookup,
      buildSession,
      now: () => now,
    });

    await client.fetchState(WALLET);
    now += 29 * DAY_MS;
    await client.fetchState(WALLET);
    expect(built).toBe(1);

    now += DAY_MS - 30 * 60 * 1000; // under the hour of validity the rebuild keeps in hand
    await client.fetchState(WALLET);
    expect(built).toBe(2);
  });

  it("does not rebuild a session a day old: the token outlives it by weeks", async () => {
    let now = 0;
    let built = 0;
    const buildSession = vi.fn(async () => {
      built += 1;
      return fakeSession(fakeClient(), now + 30 * DAY_MS);
    });

    const client = new RollupTradingClient({
      simUrl: "http://sim.test",
      marketSettingsLookup,
      buildSession,
      now: () => now,
    });

    await client.fetchState(WALLET);
    now += 2 * DAY_MS;
    await client.fetchState(WALLET);
    expect(built).toBe(1);
  });
});
