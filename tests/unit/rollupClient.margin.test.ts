import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
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

function clientShowing(views: View[], markets: Record<string, MarketInfo>) {
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
    owner: OWNER,
    orderKeyPublicKeys: [],
    client,
    deployment: DEPLOYMENT,
    tokenIndexBySymbol: new Map([["nUSD", 0]]),
    collateralToken: { mint: Keypair.generate().publicKey, custodyNonce: 0n },
    createdAtMs: NOW,
    saveKeyCheckpoint: () => {},
    close: () => {},
  });
  return new RollupTradingClient({
    simUrl: "http://sim.test",
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    now: () => NOW,
    marketSettingsLookup: (id) => markets[id],
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

  it("needs no mark when the account has no exposure", async () => {
    const rollup = clientShowing([view(500n * USDC, [{}, {}])], {});
    const state = await rollup.fetchState(WALLET);
    expect(state.equity).toBe("500.000000");
    expect(state.collateral).toMatchObject({ reserved: "0.000000", available: "500.000000" });
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
