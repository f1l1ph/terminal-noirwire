import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { keypairOwnerSigner } from "@/lib/wallet/ownerSigner";
import { RollupTradingClient } from "@/lib/trading/rollupClient";
import type { RollupSession, TraderClientLike } from "@/lib/rollup/session";
import type { PublicDeployment } from "@/lib/rollup/deployment";
import type { MarketInfo } from "@/lib/market-data/types";
import type { WalletIdentity } from "@/lib/trading/types";
import {
  RESULT_STATUS_CODE,
  TransactionFailed,
  type OrderResult,
  type Placed,
  type View,
} from "@/lib/rollup/sdk";
import {
  KEYS_IN_USE_ELSEWHERE_REASON,
  POSITION_ALREADY_REDUCED_REASON,
} from "@/lib/rollup/outcome";
import { describeProgramError, PROGRAM_ERROR } from "@/lib/rollup/refusals";

const PERP: MarketInfo = {
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

const USDC = 1_000_000n;
const emptySlot = { base: 0n, quote: 0n, openBidLots: 0n, openAskLots: 0n };

function viewWith(base: bigint, resultsWritten: number): View {
  return {
    orderKeys: [],
    resultsWritten,
    results: [],
    snapshot: {
      seat: {
        collateral: 500n * USDC,
        spot: [],
        perp: [{ ...emptySlot, base, quote: base === 0n ? 0n : -1000n * USDC }],
        openOrders: [],
      },
      marketId: 0,
      orders: [],
    },
  } as unknown as View;
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

const WALLET: WalletIdentity = { address: "owner-address", secretKeyHex: "aa".repeat(64) };
const ORDER = { market: "NSOL-PERP", side: "sell", type: "market", price: "100.00", size: "1" };

const notOrderKey = () =>
  new TransactionFailed("sig", {
    InstructionError: [0, { Custom: 6000 + PROGRAM_ERROR.notOrderKey }],
  });

function refusedResult(code: number): OrderResult {
  return {
    clientOrderId: 1n,
    orderSeq: 0n,
    filled: 0n,
    filledNotional: 0n,
    rested: 0n,
    cancelled: 0n,
    fee: 0n,
    kind: 1,
    status: RESULT_STATUS_CODE.refused,
    code,
  } as OrderResult;
}

const SYNCED = { ...refusedResult(0), sentAt: 0, resultAt: 1 };

function filledPlaced(view: View): Placed {
  return {
    outcome: "placed",
    clientOrderId: 1n,
    result: {
      ...refusedResult(0),
      filled: 1000n,
      status: RESULT_STATUS_CODE.filled,
    },
    secret: new Uint8Array(16),
    view,
    sentAt: 0,
    resultAt: 1,
  } as Placed;
}

function refusedPlaced(code: number): Placed {
  return {
    outcome: "placed",
    clientOrderId: 1n,
    result: refusedResult(code),
    secret: new Uint8Array(16),
    view: viewWith(10_000n, 1),
    sentAt: 0,
    resultAt: 1,
  } as Placed;
}

function trading(
  overrides: Partial<TraderClientLike>,
  options: { views?: View[]; resync?: (view: View) => void } = {},
) {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
  const unused = async () => {
    throw new Error("unused");
  };
  const views = options.views ?? [viewWith(0n, 1)];
  let read = 0;
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
  const session: RollupSession = {
    owner: keypairOwnerSigner(Keypair.generate()),
    orderKeyPublicKeys: [],
    client,
    deployment: DEPLOYMENT,
    tokenIndexBySymbol: new Map([["nUSD", 0]]),
    collateralToken: { mint: Keypair.generate().publicKey, custodyNonce: 0n },
    gate: Keypair.generate().publicKey,
    tokenExpiresAtMs: Number.MAX_SAFE_INTEGER,
    saveKeyCheckpoint: () => {},
    resyncKeys: options.resync ?? (() => {}),
    close: () => {},
  };
  return new RollupTradingClient({
    simUrl: "http://sim.test",
    marketSettingsLookup: (id) => (id === "NSOL-PERP" ? PERP : undefined),
    storage,
    buildSession: async () => session,
  });
}

describe("a refused order key is resynced once and the call retried once", () => {
  it("places the order on the retry after a resync from the view", async () => {
    let sends = 0;
    let resyncs = 0;
    const rollup = trading(
      {
        placeOrder: async () => {
          sends += 1;
          if (sends === 1) throw notOrderKey();
          return filledPlaced(viewWith(0n, 2));
        },
      },
      { resync: () => void (resyncs += 1) },
    );
    const result = await rollup.placeOrder(WALLET, ORDER as never);
    expect(sends).toBe(2);
    expect(resyncs).toBe(1);
    expect(result.status).toBe("filled");
  });

  it("also treats a refusal written to the result ring as a dead key", async () => {
    let sends = 0;
    const rollup = trading({
      placeOrder: async () => {
        sends += 1;
        return sends === 1
          ? refusedPlaced(PROGRAM_ERROR.notOrderKey)
          : filledPlaced(viewWith(0n, 2));
      },
    });
    const result = await rollup.placeOrder(WALLET, ORDER as never);
    expect(sends).toBe(2);
    expect(result.status).toBe("filled");
  });

  it("says the account is in use elsewhere when the retry is refused too, and retries only once", async () => {
    let sends = 0;
    let resyncs = 0;
    const rollup = trading(
      {
        placeOrder: async () => {
          sends += 1;
          throw notOrderKey();
        },
      },
      { resync: () => void (resyncs += 1) },
    );
    const result = await rollup.placeOrder(WALLET, ORDER as never);
    expect(sends).toBe(2);
    expect(resyncs).toBe(1);
    expect(result.status).toBe("rejected");
    expect(result.reason).toBe(KEYS_IN_USE_ELSEWHERE_REASON);
    expect(result.reason).toMatch(/another tab/);
  });

  it("does not retry a refusal that is not about the key", async () => {
    let sends = 0;
    const rollup = trading({
      placeOrder: async () => {
        sends += 1;
        return refusedPlaced(PROGRAM_ERROR.insufficientMargin);
      },
    });
    const result = await rollup.placeOrder(WALLET, ORDER as never);
    expect(sends).toBe(1);
    expect(result.status).toBe("rejected");
  });

  it("retries a cancel after a resync", async () => {
    let calls = 0;
    const rollup = trading({
      cancelOrder: async () => {
        calls += 1;
        if (calls === 1) throw notOrderKey();
        return {
          ...refusedResult(0),
          cancelled: 1000n,
          status: RESULT_STATUS_CODE.filled,
        } as never;
      },
    });
    const result = await rollup.cancelOrder(WALLET, "NSOL-PERP", "7");
    expect(calls).toBe(2);
    expect(result.cancelled).toBeGreaterThan(0);
  });

  it("reports the account in use elsewhere when a cancel is refused twice", async () => {
    let calls = 0;
    const rollup = trading({
      cancelAll: async () => {
        calls += 1;
        throw notOrderKey();
      },
    });
    const result = await rollup.cancelAllInMarket(WALLET, "NSOL-PERP");
    expect(calls).toBe(2);
    expect(result).toEqual({ cancelled: 0, reason: KEYS_IN_USE_ELSEWHERE_REASON });
  });
});

describe("a reduce-only order refused with ReduceOnlyWouldIncrease", () => {
  const REDUCE = { ...ORDER, reduceOnly: true };

  it("says the position was already closed when a sync shows it gone", async () => {
    let syncs = 0;
    const rollup = trading(
      {
        placeOrder: async () => refusedPlaced(PROGRAM_ERROR.reduceOnlyWouldIncrease),
        syncView: async () => {
          syncs += 1;
          return SYNCED;
        },
      },
      { views: [viewWith(10_000n, 1), viewWith(10_000n, 1), viewWith(0n, 2)] },
    );
    await rollup.fetchState(WALLET);
    const result = await rollup.placeOrder(WALLET, REDUCE as never);
    expect(syncs).toBe(1);
    expect(result.status).toBe("rejected");
    expect(result.reason).toBe(POSITION_ALREADY_REDUCED_REASON);
    expect(result.reason).toMatch(/liquidation/);
    expect(rollup.repriceState(WALLET)?.positions["NSOL-PERP"]).toBeUndefined();
  });

  it("says so when the position is now smaller than it was shown", async () => {
    const rollup = trading(
      {
        placeOrder: async () => refusedPlaced(PROGRAM_ERROR.reduceOnlyWouldIncrease),
        syncView: async () => SYNCED,
      },
      { views: [viewWith(10_000n, 1), viewWith(10_000n, 1), viewWith(4_000n, 2)] },
    );
    await rollup.fetchState(WALLET);
    const result = await rollup.placeOrder(WALLET, REDUCE as never);
    expect(result.reason).toBe(POSITION_ALREADY_REDUCED_REASON);
  });

  it("keeps the existing sentence when the position is still there", async () => {
    const rollup = trading(
      {
        placeOrder: async () => refusedPlaced(PROGRAM_ERROR.reduceOnlyWouldIncrease),
        syncView: async () => SYNCED,
      },
      { views: [viewWith(10_000n, 1), viewWith(10_000n, 1), viewWith(10_000n, 2)] },
    );
    await rollup.fetchState(WALLET);
    const result = await rollup.placeOrder(WALLET, REDUCE as never);
    expect(result.reason).toBe(describeProgramError(PROGRAM_ERROR.reduceOnlyWouldIncrease));
  });

  it("keeps the existing sentence when the account cannot be read again", async () => {
    let reads = 0;
    const rollup = trading({
      placeOrder: async () => refusedPlaced(PROGRAM_ERROR.reduceOnlyWouldIncrease),
      syncView: async () => SYNCED,
      view: async () => {
        reads += 1;
        if (reads > 2) throw new Error("offline");
        return viewWith(10_000n, 1);
      },
    });
    await rollup.fetchState(WALLET);
    const result = await rollup.placeOrder(WALLET, REDUCE as never);
    expect(result.reason).toBe(describeProgramError(PROGRAM_ERROR.reduceOnlyWouldIncrease));
  });
});
