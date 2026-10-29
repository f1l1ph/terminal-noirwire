import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { keypairOwnerSigner } from "@/lib/wallet/ownerSigner";
import { RollupTradingClient } from "@/lib/trading/rollupClient";
import type { ChainMarketLimits, RollupSession, TraderClientLike } from "@/lib/rollup/session";
import type { PublicDeployment } from "@/lib/rollup/deployment";
import type { MarketInfo } from "@/lib/market-data/types";
import type { NewOrderInput, TraderState, WalletIdentity } from "@/lib/trading/types";
import {
  OutcomeUnknown,
  RESULT_STATUS_CODE,
  type OrderResult,
  type Placed,
  type View,
} from "@/lib/rollup/sdk";
import { PROGRAM_ERROR } from "@/lib/rollup/refusals";

const PERP: MarketInfo = {
  id: "NSOL-PERP",
  kind: "perp",
  base: "SOL",
  quote: "nUSD",
  tickSize: "0.010000",
  lotSize: "0.001000",
  maxLeverage: 5,
  markPrice: "150.000000",
  markPriceUpdatedAtMs: Date.now(),
  change24hPercent: 0,
  volume24h: "0",
  openInterest: "0",
};

const USDC = 1_000_000n;

const DEPLOYMENT: PublicDeployment = {
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

const OWNER = Keypair.generate();
const WALLET: WalletIdentity = {
  address: OWNER.publicKey.toBase58(),
  secretKeyHex: "aa".repeat(64),
};

/** One resting buy of 1 SOL that expires at `expiry` (unix seconds), or the account with nothing resting. */
function viewWith(resting: boolean, resultsWritten: number, expiry = 0n): View {
  return {
    orderKeys: [],
    resultsWritten,
    results: [],
    seatRecorded: true,
    snapshotOld: false,
    snapshot: {
      seat: {
        collateral: 500n * USDC,
        spot: [],
        positions: [
          {
            marketId: 0,
            base: 0n,
            quote: 0n,
            openBidLots: resting ? 1_000n : 0n,
            openAskLots: 0n,
          },
        ],
      },
      marketId: 0,
      orders: resting
        ? [{ sequence: 7n, side: 0, price: 149_000n, remaining: 1_000n, expiry }]
        : [],
    },
  } as unknown as View;
}

function result(over: Partial<OrderResult>): OrderResult {
  return {
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
    ...over,
  } as OrderResult;
}

const CHAIN_LIMITS: ChainMarketLimits = {
  imBps: 2000,
  mmBps: 500,
  takerFeeBps: 5,
  bandBps: 400,
  minSize: 1n,
  minNotional: 0n,
  positionCap: 2_200n,
  maxOpenOrders: 32,
};

function trading(overrides: Partial<TraderClientLike>, views: View[] = [viewWith(false, 1)]) {
  let read = 0;
  const unused = async () => {
    throw new Error("unused");
  };
  const client: TraderClientLike = {
    view: async () => views[Math.min(read++, views.length - 1)],
    subscribeView: () => async () => {},
    placeOrder: unused,
    cancelOrder: unused,
    cancelAll: unused,
    syncView: unused,
    transferBetweenBalances: unused,
    ...overrides,
  };
  return new RollupTradingClient({
    simUrl: "http://sim.test",
    marketSettingsLookup: (id) => (id === "NSOL-PERP" ? PERP : undefined),
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    buildSession: async (): Promise<RollupSession> => ({
      owner: keypairOwnerSigner(OWNER),
      orderKeyPublicKeys: [],
      client,
      deployment: DEPLOYMENT,
      tokenIndexBySymbol: new Map([["nUSD", 0]]),
      collateralToken: { mint: Keypair.generate().publicKey, custodyNonce: 0n },
      gate: Keypair.generate().publicKey,
      limits: new Map([[0, CHAIN_LIMITS]]),
      tokenExpiresAtMs: Number.MAX_SAFE_INTEGER,
      saveKeyCheckpoint: () => {},
      close: () => {},
    }),
  });
}

describe("syncMarket says whether the view was refreshed", () => {
  it("is true when the sync landed", async () => {
    const rollup = trading({
      syncView: async () => result({ status: RESULT_STATUS_CODE.filled }) as never,
    });
    expect(await rollup.syncMarket(WALLET, "NSOL-PERP")).toBe(true);
  });

  it("is false when the program answers the sync with a refusal", async () => {
    const rollup = trading({
      syncView: async () =>
        result({ status: RESULT_STATUS_CODE.refused, code: PROGRAM_ERROR.seatNotOpen }) as never,
    });
    expect(await rollup.syncMarket(WALLET, "NSOL-PERP")).toBe(false);
  });

  it("is false when the sync failed, instead of passing in silence", async () => {
    const rollup = trading({
      syncView: async () => {
        throw new Error("every order key is in use");
      },
    });
    expect(await rollup.syncMarket(WALLET, "NSOL-PERP")).toBe(false);
  });

  it("is false when the sync's outcome is not known", async () => {
    const rollup = trading({
      syncView: async () => {
        throw new OutcomeUnknown(1n, Promise.resolve(null));
      },
    });
    expect(await rollup.syncMarket(WALLET, "NSOL-PERP")).toBe(false);
  });

  it("is true for a market this terminal does not trade, which has nothing to refresh", async () => {
    expect(await trading({}).syncMarket(WALLET, "UNKNOWN-PERP")).toBe(true);
  });
});

describe("a cancel that landed refreshes the account at once", () => {
  it("shows the order gone and its margin free without waiting for the subscription", async () => {
    const states: TraderState[] = [];
    const rollup = trading({ cancelOrder: async () => result({ cancelled: 1_000n }) as never }, [
      viewWith(true, 1, 10n),
      viewWith(false, 2),
    ]);
    rollup.subscribe(WALLET, (state) => states.push(state));
    await vi.waitFor(() => expect(states).toHaveLength(1));
    expect(states[0].openOrders).toHaveLength(1);
    expect(states[0].collateral?.reserved).not.toBe("0.000000");

    const cancelled = await rollup.cancelOrder(WALLET, "NSOL-PERP", "7");
    expect(cancelled.cancelled).toBe(1_000);
    expect(states).toHaveLength(2);
    expect(states[1].openOrders).toEqual([]);
    expect(states[1].collateral).toMatchObject({ reserved: "0.000000", available: "500.000000" });
  });

  it("still returns the cancel when the account cannot be read again", async () => {
    let reads = 0;
    const rollup = trading({
      cancelOrder: async () => result({ cancelled: 1_000n }) as never,
      view: async () => {
        reads += 1;
        if (reads > 1) throw new Error("offline");
        return viewWith(true, 1);
      },
    });
    const cancelled = await rollup.cancelOrder(WALLET, "NSOL-PERP", "7");
    expect(cancelled.cancelled).toBe(1_000);
  });

  it("does not read the account again for a cancel that cancelled nothing", async () => {
    let reads = 0;
    const rollup = trading({
      cancelOrder: async () =>
        result({ cancelled: 0n, code: PROGRAM_ERROR.orderNotFound }) as never,
      view: async () => {
        reads += 1;
        return viewWith(false, 1);
      },
    });
    const shown: TraderState[] = [];
    rollup.subscribe(WALLET, (state) => shown.push(state));
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    const readsBefore = reads;
    await rollup.cancelOrder(WALLET, "NSOL-PERP", "7");
    expect(reads).toBe(readsBefore);
  });
});

describe("an open order carries its own expiry", () => {
  it("reports the program's expiry in milliseconds, and none for an order that never expires", async () => {
    const expiring = trading({}, [viewWith(true, 1, 1_900n)]);
    expect((await expiring.fetchState(WALLET)).openOrders[0].expiresAtMs).toBe(1_900_000);
    const lasting = trading({}, [viewWith(true, 1, 0n)]);
    expect((await lasting.fetchState(WALLET)).openOrders[0].expiresAtMs).toBeNull();
  });
});

describe("a refusal for the position limit names the number", () => {
  const ORDER: NewOrderInput = {
    market: "NSOL-PERP",
    side: "buy",
    type: "market",
    price: "151.00",
    size: "3",
  };

  function refusedPlaced(code: number): Placed {
    return {
      outcome: "placed",
      clientOrderId: 1n,
      result: result({ status: RESULT_STATUS_CODE.refused, code }),
      secret: new Uint8Array(16),
      view: viewWith(false, 2),
      sentAt: 0,
      resultAt: 1,
    } as Placed;
  }

  it("gives the market's limit in the order's own units", async () => {
    const rollup = trading({
      placeOrder: async () => refusedPlaced(PROGRAM_ERROR.positionCapExceeded),
    });
    const placed = await rollup.placeOrder(WALLET, ORDER);
    expect(placed.status).toBe("rejected");
    expect(placed.reason).toContain("this market's limit of 2.200 on one side");
  });

  it("gives the open order limit", async () => {
    const rollup = trading({
      placeOrder: async () => refusedPlaced(PROGRAM_ERROR.tooManyOpenOrders),
    });
    const placed = await rollup.placeOrder(WALLET, { ...ORDER, type: "limit", price: "149.00" });
    expect(placed.reason).toContain("the most open orders (32)");
  });
});
