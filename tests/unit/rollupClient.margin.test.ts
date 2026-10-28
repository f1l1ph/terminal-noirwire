import { describe, expect, it, vi } from "vitest";
import { MarketDataStore } from "@/lib/market-data/store";
import { marketWithLiveMark, STALE_MARK_MS } from "@/lib/market-data/selectors";
import { Keypair } from "@solana/web3.js";
import { keypairOwnerSigner } from "@/lib/wallet/ownerSigner";
import { RollupTradingClient } from "@/lib/trading/rollupClient";
import type { RollupSession, TraderClientLike } from "@/lib/rollup/session";
import type { PublicDeployment } from "@/lib/rollup/deployment";
import type { MarketInfo } from "@/lib/market-data/types";
import type { WalletIdentity } from "@/lib/trading/types";
import type { View } from "@/lib/rollup/sdk";

const NOW = 1_800_000_000_000;

function perp(id: string, markPrice: string | null, markAgeMs = 0): MarketInfo {
  return {
    id,
    kind: "perp",
    base: "SOL",
    quote: "nUSD",
    tickSize: "0.010000",
    lotSize: "0.001000",
    maxLeverage: 10,
    markPrice,
    markPriceUpdatedAtMs: markPrice === null ? null : NOW - markAgeMs,
    change24hPercent: 0,
    volume24h: "0",
    openInterest: "0",
  };
}

function deploymentMarket(marketId: number, symbol: string, baseDecimals: number, lot: string) {
  return {
    marketId,
    symbol,
    kind: "perp" as const,
    market: Keypair.generate().publicKey.toBase58(),
    tape: Keypair.generate().publicKey.toBase58(),
    priceFeed: Keypair.generate().publicKey.toBase58(),
    baseToken: null,
    quoteToken: { symbol: "nUSD", mint: Keypair.generate().publicKey.toBase58(), decimals: 6 },
    baseDecimals,
    quoteDecimals: 6,
    lotSize: lot,
    tick: "100",
  };
}

const DEPLOYMENT: PublicDeployment = {
  network: "localnet",
  programId: Keypair.generate().publicKey.toBase58(),
  solanaRpcUrl: "http://127.0.0.1:8899",
  rollupRpcUrl: "http://127.0.0.1:6699",
  rollupWsUrl: "ws://127.0.0.1:6700",
  exchange: Keypair.generate().publicKey.toBase58(),
  stats: Keypair.generate().publicKey.toBase58(),
  markets: [
    deploymentMarket(0, "NSOL-PERP", 9, "1000000"),
    deploymentMarket(1, "NNVDA-PERP", 6, "1000"),
  ],
};

const OWNER = Keypair.generate();
const WALLET: WalletIdentity = {
  address: OWNER.publicKey.toBase58(),
  secretKeyHex: "aa".repeat(64),
};

const USDC = 1_000_000n;
const noSlot = { base: 0n, quote: 0n, openBidLots: 0n, openAskLots: 0n };

interface SlotInput {
  base?: bigint;
  quote?: bigint;
  openBidLots?: bigint;
  openAskLots?: bigint;
}

interface OrderInput {
  price: bigint;
  remaining: bigint;
  sequence: bigint;
  side: number;
  expiry?: bigint;
}

function view(
  collateral: bigint,
  slots: [SlotInput, SlotInput],
  snapshotMarket = 0,
  orders: OrderInput[] = [],
): View {
  return {
    orderKeys: [],
    resultsWritten: 1,
    results: [],
    snapshot: {
      seat: {
        collateral,
        spot: [],
        perp: slots.map((slot) => ({ ...noSlot, ...slot })),
        openOrders: [],
      },
      marketId: snapshotMarket,
      orders,
    },
  } as unknown as View;
}

function clientShowing(
  views: View[],
  markets: Record<string, MarketInfo> | ((id: string) => MarketInfo | undefined),
  now: () => number = () => NOW,
  limits?: RollupSession["limits"],
) {
  let next = 0;
  const unused = async () => {
    throw new Error("unused");
  };
  const client: TraderClientLike = {
    view: async () => views[Math.min(next++, views.length - 1)],
    subscribeView: () => async () => {},
    placeOrder: unused,
    cancelOrder: unused,
    cancelAll: unused,
    syncView: unused,
    transferBetweenBalances: unused,
  };
  const session = (): RollupSession => ({
    owner: keypairOwnerSigner(OWNER),
    orderKeyPublicKeys: [],
    client,
    deployment: DEPLOYMENT,
    tokenIndexBySymbol: new Map([["nUSD", 0]]),
    collateralToken: { mint: Keypair.generate().publicKey, custodyNonce: 0n },
    gate: Keypair.generate().publicKey,
    limits,
    tokenExpiresAtMs: Number.MAX_SAFE_INTEGER,
    saveKeyCheckpoint: () => {},
    close: () => {},
  });
  return new RollupTradingClient({
    simUrl: "http://sim.test",
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    now,
    marketSettingsLookup: typeof markets === "function" ? markets : (id) => markets[id],
    buildSession: async () => session(),
  });
}

describe("RollupTradingClient: margin-aware collateral", () => {
  const marks = { "NSOL-PERP": perp("NSOL-PERP", "150.000000") };

  it("counts a long's profit in equity and reserves its initial margin", async () => {
    const rollup = clientShowing(
      [view(500n * USDC, [{ base: 10_000n, quote: -1000n * USDC }, {}])],
      marks,
    );
    const state = await rollup.fetchState(WALLET);
    expect(state.equity).toBe("1000.000000");
    expect(state.collateral).toMatchObject({
      total: "500.000000",
      reserved: "150.000000",
      available: "850.000000",
    });
    expect(state.collateral?.availableUnknown).toBeUndefined();
  });

  it("makes margin unknown when the seat holds exposure in a market outside the deployment", async () => {
    const seen = view(1000n * USDC, [{ base: 10_000n, quote: -1000n * USDC }, {}]);
    // Slot 2 is a market this terminal does not trade (the deployment lists 0 and 1).
    (seen.snapshot.seat.perp as unknown[]).push({ ...noSlot, base: 5_000n, quote: -500n * USDC });
    const state = await clientShowing([seen], marks).fetchState(WALLET);
    expect(state.exposureUnreadable).toBe(true);
    expect(state.equity).toBeNull();
    expect(state.collateral?.availableUnknown).toBe(true);
    expect(Number(state.collateral?.available)).toBe(0);
    expect(Object.keys(state.positions)).toEqual(["NSOL-PERP"]);
  });

  it("flags nothing when every occupied slot is a market the deployment lists", async () => {
    const state = await clientShowing(
      [view(500n * USDC, [{ base: 10_000n, quote: -1000n * USDC }, {}])],
      marks,
    ).fetchState(WALLET);
    expect(state.exposureUnreadable).toBeUndefined();
    expect(state.collateral?.availableUnknown).toBeUndefined();
  });

  it("reserves at the market account's own initial margin ratio when the session read it", async () => {
    const limits = new Map([
      [
        0,
        {
          imBps: 2000,
          mmBps: 500,
          takerFeeBps: 5,
          bandBps: 400,
          minSize: 2n,
          minNotional: 5n * USDC,
          positionCap: 3_000n,
          maxOpenOrders: 32,
        },
      ],
    ]);
    const rollup = clientShowing(
      [view(500n * USDC, [{ base: 10_000n, quote: -1000n * USDC }, {}])],
      marks,
      () => NOW,
      limits,
    );
    const state = await rollup.fetchState(WALLET);
    expect(state.collateral).toMatchObject({ reserved: "300.000000", available: "700.000000" });
    const read = await rollup.marketLimits(WALLET);
    expect(read.get("NSOL-PERP")).toEqual({
      imBps: 2000,
      mmBps: 500,
      takerFeeBps: 5,
      bandBps: 400,
      minSize: "0.002000",
      minNotional: "5.000000",
      positionCap: "3.000000",
      maxOpenOrders: 32,
    });
  });

  it("subtracts a short's loss from equity and available", async () => {
    const rollup = clientShowing(
      [view(2000n * USDC, [{ base: -10_000n, quote: 1000n * USDC }, {}])],
      marks,
    );
    const state = await rollup.fetchState(WALLET);
    expect(state.equity).toBe("1500.000000");
    expect(state.collateral).toMatchObject({ reserved: "150.000000", available: "1350.000000" });
  });

  it("never reports negative available when losses exceed collateral", async () => {
    const rollup = clientShowing(
      [view(100n * USDC, [{ base: -10_000n, quote: 1000n * USDC }, {}])],
      marks,
    );
    const state = await rollup.fetchState(WALLET);
    expect(state.equity).toBe("-400.000000");
    expect(state.collateral?.available).toBe("0.000000");
  });

  it("locks margin for a resting order that is not yet a position", async () => {
    const rollup = clientShowing([view(1000n * USDC, [{ openBidLots: 2_000n }, {}])], marks);
    const state = await rollup.fetchState(WALLET);
    expect(state.equity).toBe("1000.000000");
    expect(state.collateral).toMatchObject({ reserved: "30.000000", available: "970.000000" });
  });

  it("rounds reserved margin up and available down", async () => {
    const rollup = clientShowing([view(1000n * USDC, [{ openBidLots: 1n }, {}])], {
      "NSOL-PERP": perp("NSOL-PERP", "150.123457"),
    });
    const state = await rollup.fetchState(WALLET);
    expect(state.collateral).toMatchObject({ reserved: "0.015013", available: "999.984987" });
  });

  it("reports available as unknown, not collateral, when the mark is missing", async () => {
    const rollup = clientShowing(
      [view(500n * USDC, [{ base: 10_000n, quote: -1000n * USDC }, {}])],
      { "NSOL-PERP": perp("NSOL-PERP", null) },
    );
    const state = await rollup.fetchState(WALLET);
    expect(state.equity).toBeNull();
    expect(state.collateral).toMatchObject({
      total: "500.000000",
      available: "0",
      availableUnknown: true,
    });
  });

  it("treats a stale mark as missing", async () => {
    const rollup = clientShowing(
      [view(500n * USDC, [{ base: 10_000n, quote: -1000n * USDC }, {}])],
      { "NSOL-PERP": perp("NSOL-PERP", "150.000000", 60_000) },
    );
    const state = await rollup.fetchState(WALLET);
    expect(state.collateral?.availableUnknown).toBe(true);
  });

  it("caps the transferable figure at the deposited collateral, not equity", async () => {
    const rollup = clientShowing(
      [view(100n * USDC, [{ base: 10_000n, quote: -1000n * USDC }, {}])],
      { "NSOL-PERP": perp("NSOL-PERP", "150.000000") },
    );
    const state = await rollup.fetchState(WALLET);
    expect(state.collateral).toMatchObject({ available: "450.000000", transferable: "100.000000" });
  });

  it("caps the transferable figure at free margin when that is lower", async () => {
    const rollup = clientShowing([view(1000n * USDC, [{ openBidLots: 2_000n }, {}])], marks);
    const state = await rollup.fetchState(WALLET);
    expect(state.collateral).toMatchObject({ available: "970.000000", transferable: "970.000000" });
  });

  it("offers no transferable figure when available is unknown", async () => {
    const rollup = clientShowing(
      [view(500n * USDC, [{ base: 10_000n, quote: -1000n * USDC }, {}])],
      { "NSOL-PERP": perp("NSOL-PERP", null) },
    );
    const state = await rollup.fetchState(WALLET);
    expect(state.collateral?.transferable).toBeUndefined();
  });

  it("values a short's loss from its signed quote after a partial buy-back", async () => {
    const rollup = clientShowing(
      [view(5000n * USDC, [{ base: -1_000n, quote: -800n * USDC }, {}])],
      { "NSOL-PERP": perp("NSOL-PERP", "200.000000") },
    );
    const state = await rollup.fetchState(WALLET);
    expect(state.equity).toBe("4000.000000");
  });

  it("marks the available figure valid only until the oldest exposed mark goes stale", async () => {
    const rollup = clientShowing(
      [
        view(1000n * USDC, [
          { base: 1_000n, quote: -100n * USDC },
          { base: 1_000n, quote: -90n * USDC },
        ]),
      ],
      {
        "NSOL-PERP": perp("NSOL-PERP", "150.000000", 1_000),
        "NNVDA-PERP": perp("NNVDA-PERP", "100.000000", 4_000),
      },
    );
    const state = await rollup.fetchState(WALLET);
    expect(state.collateral?.availableUnknown).toBeUndefined();
    expect(state.collateral?.availableValidUntilMs).toBe(NOW - 4_000 + 10_000);
  });

  it("ignores the mark of a market with no exposure when bounding validity", async () => {
    const rollup = clientShowing(
      [view(1000n * USDC, [{ base: 1_000n, quote: -100n * USDC }, {}])],
      {
        "NSOL-PERP": perp("NSOL-PERP", "150.000000", 1_000),
        "NNVDA-PERP": perp("NNVDA-PERP", "100.000000", 9_000),
      },
    );
    const state = await rollup.fetchState(WALLET);
    expect(state.collateral?.availableValidUntilMs).toBe(NOW - 1_000 + 10_000);
  });

  it("reports available as unknown when a deployment market with a position has no settings", async () => {
    const rollup = clientShowing(
      [view(1000n * USDC, [{}, { base: 1_000n, quote: -100n * USDC }])],
      marks,
    );
    const state = await rollup.fetchState(WALLET);
    expect(state.equity).toBeNull();
    expect(state.collateral).toMatchObject({ available: "0", availableUnknown: true });
  });

  it("reports available as unknown when a market with no settings holds only resting orders", async () => {
    const rollup = clientShowing([view(1000n * USDC, [{}, { openBidLots: 5n }])], marks);
    const state = await rollup.fetchState(WALLET);
    expect(state.collateral?.availableUnknown).toBe(true);
  });

  it("needs no settings for a market whose slot is empty", async () => {
    const rollup = clientShowing([view(1000n * USDC, [{}, {}])], marks);
    const state = await rollup.fetchState(WALLET);
    expect(state.collateral).toMatchObject({ available: "1000.000000" });
    expect(state.collateral?.availableUnknown).toBeUndefined();
  });

  it("needs no mark when the account has no exposure", async () => {
    const rollup = clientShowing([view(500n * USDC, [{}, {}])], {});
    const state = await rollup.fetchState(WALLET);
    expect(state.equity).toBe("500.000000");
    expect(state.collateral).toMatchObject({ reserved: "0.000000", available: "500.000000" });
  });
});

describe("RollupTradingClient: marks that keep arriving after the markets load", () => {
  const position = view(500n * USDC, [{ base: 10_000n, quote: -1000n * USDC }, {}]);

  function loadedStore(): MarketDataStore {
    const store = new MarketDataStore();
    store.setMarkets([perp("NSOL-PERP", "150.000000")]);
    return store;
  }

  function lookupOf(store: MarketDataStore) {
    return (id: string) => {
      const state = store.getState();
      return marketWithLiveMark(state.markets, state.marksByMarket, id);
    };
  }

  it("re-values the held view against the newest mark, with no read, and turns a stale figure known again", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      const store = loadedStore();
      let clock = NOW;
      const rollup = clientShowing([position], lookupOf(store), () => clock);
      expect(rollup.repriceState(WALLET)).toBeNull();
      await rollup.fetchState(WALLET);

      clock = NOW + STALE_MARK_MS * 3;
      vi.setSystemTime(clock);
      const stale = rollup.repriceState(WALLET);
      expect(stale?.collateral?.availableUnknown).toBe(true);

      store.applyMessage({
        type: "price",
        market: "NSOL-PERP",
        price: "200.000000",
        publishedAtMs: clock - 500,
      });
      const fresh = rollup.repriceState(WALLET);
      expect(fresh?.collateral?.availableUnknown).toBeUndefined();
      expect(fresh?.collateral?.availableValidUntilMs).toBe(clock - 500 + STALE_MARK_MS);
      expect(fresh?.equity).toBe("1500.000000");
      expect(fresh?.collateral?.reserved).toBe("200.000000");
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes unknown once the live marks stop and the loaded row is the only one left", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      const store = loadedStore();
      const rollup = clientShowing([position], lookupOf(store), () => NOW + STALE_MARK_MS + 1_000);
      const state = await rollup.fetchState(WALLET);
      expect(state.collateral?.availableUnknown).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RollupTradingClient: open orders across markets", () => {
  const marks = {
    "NSOL-PERP": perp("NSOL-PERP", "150.000000"),
    "NNVDA-PERP": perp("NNVDA-PERP", "100.000000"),
  };
  const solOrder: OrderInput = { price: 100_000n, remaining: 2_000n, sequence: 7n, side: 0 };
  const nvdaOrder: OrderInput = { price: 99_000n, remaining: 500n, sequence: 9n, side: 1 };

  it("keeps listing a market's resting orders after the snapshot moves to another market", async () => {
    const solOnly = view(1000n * USDC, [{ openBidLots: 2_000n }, {}], 0, [solOrder]);
    const rollup = clientShowing(
      [
        solOnly,
        solOnly,
        view(1000n * USDC, [{ openBidLots: 2_000n }, { openAskLots: 500n }], 1, [nvdaOrder]),
      ],
      marks,
    );
    const first = await rollup.fetchState(WALLET);
    expect(first.openOrders.map((order) => order.market)).toEqual(["NSOL-PERP"]);
    const second = await rollup.fetchState(WALLET);
    expect(second.openOrders.map((order) => [order.market, order.orderId, order.side])).toEqual([
      ["NSOL-PERP", "7", "buy"],
      ["NNVDA-PERP", "9", "sell"],
    ]);
  });

  it("carries each order's own expiry, null when it never expires", async () => {
    const expiring: OrderInput = { ...solOrder, expiry: 1_800_000_000n };
    const forever: OrderInput = { ...nvdaOrder, expiry: 0n };
    const rollup = clientShowing(
      [
        view(1000n * USDC, [{ openBidLots: 2_000n }, { openAskLots: 500n }], 0, [
          expiring,
          forever,
        ]),
      ],
      marks,
    );
    const state = await rollup.fetchState(WALLET);
    expect(state.openOrders.map((order) => order.expiresAtMs)).toEqual([1_800_000_000_000, null]);
  });

  it("drops a remembered market's orders once its open lots change", async () => {
    const solOnly = view(1000n * USDC, [{ openBidLots: 2_000n }, {}], 0, [solOrder]);
    const rollup = clientShowing(
      [
        solOnly,
        solOnly,
        view(1000n * USDC, [{ openBidLots: 1_000n }, { openAskLots: 500n }], 1, [nvdaOrder]),
      ],
      marks,
    );
    await rollup.fetchState(WALLET);
    const second = await rollup.fetchState(WALLET);
    expect(second.openOrders.map((order) => order.market)).toEqual(["NNVDA-PERP"]);
  });
});
