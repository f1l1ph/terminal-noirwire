import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { RollupTradingClient } from "@/lib/trading/rollupClient";
import type { RollupSession, TraderClientLike } from "@/lib/rollup/session";
import type { PublicDeployment } from "@/lib/rollup/deployment";
import type { MarketInfo } from "@/lib/market-data/types";
import type { WalletIdentity } from "@/lib/trading/types";
import { OutcomeUnknown, RESULT_STATUS_CODE, type View } from "@/lib/rollup/sdk";

/**
 * 0.3.1: `placeOrder` can return `outcome: "unknown"` (the device gave up
 * waiting while the order could still run) instead of only `placed` /
 * `expired`; `cancelOrder`/`cancelAll`/`transferBetweenBalances` throw
 * `OutcomeUnknown` instead of returning null on the same timeout, and every
 * keyed call can throw a plain "every order key is in use" when all four
 * order-key slots are already lent to another in-flight call. These tests
 * exercise `RollupTradingClient` end to end against a fake client, the same
 * harness `rollup.sessionRefresh.test.ts` uses, so they cover the real
 * wiring (outcome.ts's mapping plus rollupClient.ts's try/catch), not just
 * the pure mapping functions in isolation.
 */

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
        filled: 1_000n,
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
    cancelOrder: async () => ({
      clientOrderId: 1n,
      orderSeq: 0n,
      filled: 0n,
      filledNotional: 0n,
      rested: 0n,
      cancelled: 1n,
      fee: 0n,
      kind: 3,
      status: RESULT_STATUS_CODE.filled,
      code: 0,
      sentAt: 0,
      resultAt: 1,
    }),
    cancelAll: async () => ({
      clientOrderId: 1n,
      orderSeq: 0n,
      filled: 0n,
      filledNotional: 0n,
      rested: 0n,
      cancelled: 1n,
      fee: 0n,
      kind: 3,
      status: RESULT_STATUS_CODE.filled,
      code: 0,
      sentAt: 0,
      resultAt: 1,
    }),
    syncView: async () => {
      throw new Error("not used in these tests");
    },
    transferBetweenBalances: async () => {
      throw new Error("not used in these tests");
    },
    ...overrides,
  };
}

function fakeSession(client: TraderClientLike): RollupSession {
  return {
    owner: Keypair.generate(),
    orderKeyPublicKeys: [],
    client,
    deployment: FAKE_DEPLOYMENT,
    tokenIndexBySymbol: new Map([["nUSD", 0]]),
    createdAtMs: Date.now(),
    saveKeyCheckpoint: () => {},
  };
}

const WALLET: WalletIdentity = { address: "owner-address", secretKeyHex: "aa".repeat(64) };

function clientWith(overrides: Partial<TraderClientLike>): RollupTradingClient {
  return new RollupTradingClient({
    simUrl: "http://sim.test",
    marketSettingsLookup,
    buildSession: async () => fakeSession(fakeClient(overrides)),
  });
}

const ORDER = {
  market: "NSOL-PERP",
  side: "buy" as const,
  type: "market" as const,
  price: "150.00",
  size: "1",
};

describe("RollupTradingClient: placeOrder's unknown outcome (0.3.1)", () => {
  it("unknown then placed: returns a pending result immediately, which settles to the real fill with a landed-late note", async () => {
    const client = clientWith({
      placeOrder: async () => ({
        outcome: "unknown",
        clientOrderId: 1n,
        secret: new Uint8Array(16),
        sentAt: 0,
        settled: Promise.resolve({
          outcome: "placed",
          clientOrderId: 1n,
          result: {
            clientOrderId: 1n,
            orderSeq: 0n,
            filled: 1_000n,
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
          resultAt: 5,
        }),
      }),
    });

    const result = await client.placeOrder(WALLET, ORDER);
    expect(result.status).toBe("open");
    expect(result.reason).toMatch(/Checking with the venue/);
    expect(result.pending).toBeDefined();

    const settled = await result.pending!.settled;
    expect(settled.status).toBe("filled");
    expect(Number(settled.filledSize)).toBe(1);
    expect(settled.reason).toMatch(/Landed late/);
  });

  it("unknown then expired: the pending result settles to rejected, not placed", async () => {
    const client = clientWith({
      placeOrder: async () => ({
        outcome: "unknown",
        clientOrderId: 2n,
        secret: new Uint8Array(16),
        sentAt: 0,
        settled: Promise.resolve({
          outcome: "expired",
          clientOrderId: 2n,
          secret: new Uint8Array(16),
          view: EMPTY_VIEW,
          sentAt: 0,
        }),
      }),
    });

    const result = await client.placeOrder(WALLET, ORDER);
    expect(result.pending).toBeDefined();

    const settled = await result.pending!.settled;
    expect(settled.status).toBe("rejected");
    expect(settled.reason).toMatch(/Expired, not placed/);
  });

  it("all four order-key slots busy: placeOrder returns an immediate rejected result, not a throw", async () => {
    const client = clientWith({
      placeOrder: async () => {
        throw new Error("every order key is in use");
      },
    });

    const result = await client.placeOrder(WALLET, ORDER);
    expect(result.pending).toBeUndefined();
    expect(result.status).toBe("rejected");
    expect(result.reason).toMatch(/slots are busy/);
  });
});

describe("RollupTradingClient: cancel's unknown outcome (0.3.1)", () => {
  it("unknown then placed (a cancel that lands late): cancelAllInMarket returns a pending result that settles to the real count", async () => {
    const client = clientWith({
      cancelAll: async () => {
        const settled = Promise.resolve({
          clientOrderId: 1n,
          orderSeq: 0n,
          filled: 0n,
          filledNotional: 0n,
          rested: 0n,
          cancelled: 2n,
          fee: 0n,
          kind: 3,
          status: RESULT_STATUS_CODE.filled,
          code: 0,
          sentAt: 0,
          resultAt: 5,
        });
        throw new OutcomeUnknown(1n, settled);
      },
    });

    const result = await client.cancelAllInMarket(WALLET, "NSOL-PERP");
    expect(result.cancelled).toBe(0);
    expect(result.pending).toBeDefined();

    const settled = await result.pending!.settled;
    expect(settled.cancelled).toBe(2);
  });

  it("all four order-key slots busy: cancelAllInMarket returns an immediate zero with a plain reason, not a throw", async () => {
    const client = clientWith({
      cancelAll: async () => {
        throw new Error("every order key is in use");
      },
    });

    const result = await client.cancelAllInMarket(WALLET, "NSOL-PERP");
    expect(result.pending).toBeUndefined();
    expect(result.cancelled).toBe(0);
    expect(result.reason).toMatch(/slots are busy/);
  });
});
