import { describe, expect, it } from "vitest";
import { Keypair, type Connection } from "@solana/web3.js";
import { keypairOwnerSigner } from "@/lib/wallet/ownerSigner";
import { RollupTradingClient } from "@/lib/trading/rollupClient";
import type { ChainMarketLimits, RollupSession, TraderClientLike } from "@/lib/rollup/session";
import type { PublicDeployment } from "@/lib/rollup/deployment";
import type { MarketInfo } from "@/lib/market-data/types";
import type { NewOrderInput, WalletIdentity } from "@/lib/trading/types";
import type { View } from "@/lib/rollup/sdk";

const DEVICE_MS = 1_000_000;

const PERP: MarketInfo = {
  id: "NSOL-PERP",
  kind: "perp",
  base: "SOL",
  quote: "USDC",
  tickSize: "0.010000",
  lotSize: "0.001000",
  maxLeverage: 5,
  markPrice: "150.000000",
  markPriceUpdatedAtMs: DEVICE_MS,
  change24hPercent: 0,
  volume24h: "0",
  openInterest: "0",
};

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
      quoteToken: { symbol: "USDC", mint: Keypair.generate().publicKey.toBase58(), decimals: 6 },
      baseDecimals: 9,
      quoteDecimals: 6,
      lotSize: "1000000",
      tick: "100",
    },
  ],
};

const WALLET: WalletIdentity = { address: "owner-address", secretKeyHex: "aa".repeat(64) };

const LIMITS: ChainMarketLimits = {
  imBps: 2000,
  mmBps: 500,
  takerFeeBps: 5,
  bandBps: 400,
  minSize: 1n,
  minNotional: 1_000_000n,
  positionCap: 2_200n,
  maxOpenOrders: 32,
};

function viewHolding(base: bigint): View {
  return {
    orderKeys: [],
    resultsWritten: 1,
    results: [],
    snapshot: {
      seat: {
        collateral: 100_000_000n,
        spot: [],
        perp: [{ base, quote: -base * 150_000n, openBidLots: 0n, openAskLots: 0n }],
        openOrders: [],
      },
      marketId: 0,
      orders: [],
    },
  } as unknown as View;
}

/** A connection whose clock sysvar reads `unixSeconds`. */
function readerWithClock(unixSeconds: number, reads: { count: number }): Connection {
  const data = new Uint8Array(40);
  new DataView(data.buffer).setBigInt64(32, BigInt(unixSeconds), true);
  return {
    getAccountInfo: async () => {
      reads.count += 1;
      return { data };
    },
  } as unknown as Connection;
}

interface Options {
  base?: bigint;
  rollupSeconds?: number;
  clockFails?: boolean;
}

function trading({ base = 0n, rollupSeconds, clockFails = false }: Options = {}) {
  const device = { ms: DEVICE_MS };
  const sent: { order: Parameters<TraderClientLike["placeOrder"]>[1] }[] = [];
  const reads = { count: 0 };
  const unused = async () => {
    throw new Error("unused");
  };
  const client: TraderClientLike = {
    view: async () => viewHolding(base),
    subscribeView: () => async () => {},
    placeOrder: async (_market, order) => {
      sent.push({ order });
      throw new Error("sent");
    },
    cancelOrder: unused,
    cancelAll: unused,
    syncView: unused,
    transferBetweenBalances: unused,
  };
  const reader =
    rollupSeconds === undefined
      ? undefined
      : clockFails
        ? ({
            getAccountInfo: async () => {
              throw new Error("down");
            },
          } as unknown as Connection)
        : readerWithClock(rollupSeconds, reads);
  const rollup = new RollupTradingClient({
    simUrl: "http://sim.test",
    marketSettingsLookup: (id) => (id === "NSOL-PERP" ? PERP : undefined),
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    now: () => device.ms,
    buildSession: async (): Promise<RollupSession> => ({
      owner: keypairOwnerSigner(Keypair.generate()),
      orderKeyPublicKeys: [],
      client,
      deployment: DEPLOYMENT,
      reader,
      tokenIndexBySymbol: new Map([["USDC", 0]]),
      collateralToken: { mint: Keypair.generate().publicKey, custodyNonce: 0n },
      gate: Keypair.generate().publicKey,
      limits: new Map([[0, LIMITS]]),
      tokenExpiresAtMs: Number.MAX_SAFE_INTEGER,
      saveKeyCheckpoint: () => {},
      close: () => {},
    }),
  });
  return { rollup, sent, reads, device };
}

const LIMIT_BUY: NewOrderInput = {
  market: "NSOL-PERP",
  side: "buy",
  type: "limit",
  price: "149.00",
  size: "1",
  goodFor: "1m",
};

describe("an order's own expiry is counted on the rollup's clock", () => {
  it("adds the good-for time to the rollup's clock, not the device's", async () => {
    const { rollup, sent } = trading({ rollupSeconds: DEVICE_MS / 1000 + 90 });
    await rollup.placeOrder(WALLET, LIMIT_BUY).catch(() => {});
    expect(sent[0].order.expiry).toBe(BigInt(DEVICE_MS / 1000 + 90 + 60));
  });

  it("follows a rollup clock that runs behind the device", async () => {
    const { rollup, sent } = trading({ rollupSeconds: DEVICE_MS / 1000 - 50 });
    await rollup.placeOrder(WALLET, { ...LIMIT_BUY, goodFor: "1h" }).catch(() => {});
    expect(sent[0].order.expiry).toBe(BigInt(DEVICE_MS / 1000 - 50 + 3_600));
  });

  it("falls back to the device clock when the rollup's cannot be read", async () => {
    const { rollup, sent } = trading({ rollupSeconds: 1, clockFails: true });
    await rollup.placeOrder(WALLET, LIMIT_BUY).catch(() => {});
    expect(sent[0].order.expiry).toBe(BigInt(DEVICE_MS / 1000 + 60));
  });

  it("sends no expiry for an order good until cancelled", async () => {
    const { rollup, sent } = trading({ rollupSeconds: DEVICE_MS / 1000 + 90 });
    await rollup.placeOrder(WALLET, { ...LIMIT_BUY, goodFor: "untilCancelled" }).catch(() => {});
    expect(sent[0].order.expiry).toBeUndefined();
  });

  it("reads the rollup's clock once and keeps the reading for later orders", async () => {
    const { rollup, reads } = trading({ rollupSeconds: DEVICE_MS / 1000 });
    await rollup.placeOrder(WALLET, LIMIT_BUY).catch(() => {});
    await rollup.placeOrder(WALLET, LIMIT_BUY).catch(() => {});
    expect(reads.count).toBe(1);
  });

  it("reads the clock again, rather than trusting the kept reading, once it is older than five minutes", async () => {
    const { rollup, reads, device } = trading({ rollupSeconds: DEVICE_MS / 1000 });
    await rollup.clockOffsetMs(WALLET);
    device.ms += 299_000;
    await rollup.clockOffsetMs(WALLET);
    expect(reads.count).toBe(1);
    device.ms += 2_000;
    await rollup.clockOffsetMs(WALLET);
    expect(reads.count).toBe(2);
  });

  it("does not trust a kept reading that looks to be from the future after the device clock moved backward", async () => {
    const { rollup, reads, device } = trading({ rollupSeconds: DEVICE_MS / 1000 });
    await rollup.clockOffsetMs(WALLET);
    device.ms -= 3_600_000;
    await rollup.clockOffsetMs(WALLET);
    expect(reads.count).toBe(2);
    await rollup.placeOrder(WALLET, LIMIT_BUY).catch(() => {});
    expect(reads.count).toBe(2);
  });

  it("reports how far the rollup's clock is ahead, in milliseconds", async () => {
    const ahead = trading({ rollupSeconds: DEVICE_MS / 1000 + 90 });
    expect(await ahead.rollup.clockOffsetMs(WALLET)).toBe(90_000);
    const behind = trading({ rollupSeconds: DEVICE_MS / 1000 - 5 });
    expect(await behind.rollup.clockOffsetMs(WALLET)).toBe(-5_000);
  });

  it("reads the rollup's clock afresh for a cancel decision, whatever offset it kept", async () => {
    const { rollup, reads } = trading({ rollupSeconds: DEVICE_MS / 1000 + 90 });
    expect(await rollup.clockOffsetMs(WALLET)).toBe(90_000);
    expect(await rollup.rollupNowMs(WALLET)).toBe((DEVICE_MS / 1000 + 90) * 1000);
    expect(await rollup.rollupNowMs(WALLET)).toBe((DEVICE_MS / 1000 + 90) * 1000);
    expect(reads.count).toBe(3);
  });

  it("gives no reading when the rollup's clock cannot be read, rather than a kept one", async () => {
    const failing = trading({ rollupSeconds: 1, clockFails: true });
    expect(await failing.rollup.rollupNowMs(WALLET)).toBeNull();
    expect(await trading().rollup.rollupNowMs(WALLET)).toBeNull();
  });

  it("reports no offset when the clock has never been read", async () => {
    const { rollup } = trading({ rollupSeconds: 1, clockFails: true });
    expect(await rollup.clockOffsetMs(WALLET)).toBeNull();
    const noReader = trading();
    expect(await noReader.rollup.clockOffsetMs(WALLET)).toBeNull();
  });
});

describe("a reduce-only close of a small position", () => {
  const CLOSE: NewOrderInput = {
    market: "NSOL-PERP",
    side: "sell",
    type: "market",
    price: "150.00",
    size: "0.005",
    reduceOnly: true,
  };

  it("is lifted to the lots the minimum order value needs, which the program trims to the position", async () => {
    const { rollup, sent } = trading({ base: 5n });
    await rollup.fetchState(WALLET);
    await rollup.placeOrder(WALLET, CLOSE).catch(() => {});
    // 1 USDC at 0.15 USDC a lot is 7 lots; the position is 5.
    expect(sent[0].order.size).toBe(7n);
    expect(sent[0].order.reduceOnly).toBe(true);
  });

  it("keeps a close that already clears the minimum at the position", async () => {
    const { rollup, sent } = trading({ base: 20n });
    await rollup.fetchState(WALLET);
    await rollup.placeOrder(WALLET, { ...CLOSE, size: "0.02" }).catch(() => {});
    expect(sent[0].order.size).toBe(20n);
  });

  it("leaves a partial reduction as typed", async () => {
    const { rollup, sent } = trading({ base: 20n });
    await rollup.fetchState(WALLET);
    await rollup.placeOrder(WALLET, { ...CLOSE, size: "0.01" }).catch(() => {});
    expect(sent[0].order.size).toBe(10n);
  });

  it("leaves an order that is not reduce-only as typed", async () => {
    const { rollup, sent } = trading({ base: 5n });
    await rollup.fetchState(WALLET);
    await rollup
      .placeOrder(WALLET, { ...CLOSE, reduceOnly: undefined, size: "0.01" })
      .catch(() => {});
    expect(sent[0].order.size).toBe(10n);
  });
});
