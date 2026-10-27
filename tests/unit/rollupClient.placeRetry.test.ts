import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { keypairOwnerSigner } from "@/lib/wallet/ownerSigner";
import { RollupTradingClient } from "@/lib/trading/rollupClient";
import { SessionAuthError, type RollupSession, type TraderClientLike } from "@/lib/rollup/session";
import { OrderOutcomeUnknownError } from "@/lib/trading/unknownOutcome";
import type { PublicDeployment } from "@/lib/rollup/deployment";
import type { MarketInfo } from "@/lib/market-data/types";
import type { WalletIdentity } from "@/lib/trading/types";
import { loadTrackedSecrets } from "@/lib/rollup/secretStore";
import { OrderInvalid, OutcomeUnknown, RESULT_STATUS_CODE, type View } from "@/lib/rollup/sdk";

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

const VIEW = {
  orderKeys: [],
  resultsWritten: 0,
  results: [],
  snapshot: {
    seat: { collateral: 0n, spot: [], perp: [], openOrders: [] },
    marketId: 0,
    orders: [],
  },
} as unknown as View;

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

/** The package says the order ran, with no result to read: the order left, so the market stays held. */
const SENT_BUT_UNREADABLE = { outcome: "placed" } as never;

function trading(placeOrder: TraderClientLike["placeOrder"], failFirstBuildWith?: Error) {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
  const unused = async () => {
    throw new Error("unused");
  };
  const client: TraderClientLike = {
    view: async () => VIEW,
    subscribeView: () => async () => {},
    placeOrder,
    cancelOrder: unused,
    cancelAll: unused,
    syncView: unused,
    transferBetweenBalances: unused,
  };
  let builds = 0;
  const session = (): RollupSession => ({
    owner: keypairOwnerSigner(Keypair.generate()),
    orderKeyPublicKeys: [],
    client,
    deployment: DEPLOYMENT,
    tokenIndexBySymbol: new Map([["nUSD", 0]]),
    collateralToken: { mint: Keypair.generate().publicKey, custodyNonce: 0n },
    gate: Keypair.generate().publicKey,
    tokenExpiresAtMs: Number.MAX_SAFE_INTEGER,
    saveKeyCheckpoint: () => {},
    close: () => {},
  });
  const rollup = new RollupTradingClient({
    simUrl: "http://sim.test",
    marketSettingsLookup: (id) => (id === "NSOL-PERP" ? PERP : undefined),
    storage,
    buildSession: async () => {
      builds += 1;
      if (builds === 1 && failFirstBuildWith) throw failFirstBuildWith;
      return session();
    },
  });
  return { rollup, storage, builds: () => builds };
}

describe("placeOrder: retries only what was never sent", () => {
  it("rebuilds the session once after a typed sign-in failure, before any order call", async () => {
    let calls = 0;
    const { rollup, storage, builds } = trading(
      async () => {
        calls += 1;
        return {
          outcome: "placed",
          clientOrderId: 1n,
          result: {
            clientOrderId: 1n,
            orderSeq: 0n,
            filled: 1000n,
            filledNotional: 0n,
            rested: 0n,
            cancelled: 0n,
            fee: 0n,
            kind: 1,
            status: RESULT_STATUS_CODE.filled,
            code: 0,
          },
          secret: new Uint8Array(16),
          view: VIEW,
          sentAt: 0,
          resultAt: 1,
        } as never;
      },
      new SessionAuthError(new Error("401 Missing token query param")),
    );
    const result = await rollup.placeOrder(WALLET, ORDER as never);
    expect(calls).toBe(1);
    expect(builds()).toBe(2);
    expect(result.status).toBe("filled");
    const tracked = loadTrackedSecrets(storage, WALLET.address);
    expect(tracked.map((entry) => entry.secretHex)).toEqual([result.tag]);
  });

  it("tracks the order's secret before sending, and settles an unknown outcome to its real result", async () => {
    const settled = Promise.resolve(null);
    const { rollup, storage } = trading(async () => {
      throw new OutcomeUnknown(1n, settled, new Error("socket hang up"));
    });
    const result = await rollup.placeOrder(WALLET, ORDER as never);

    const tracked = loadTrackedSecrets(storage, WALLET.address);
    expect(tracked.map((entry) => entry.secretHex)).toEqual([result.tag]);
    expect(result.pending).toBeDefined();
    expect((await result.pending!.settled).reason).toMatch(/^Expired, not placed/);
  });

  it("settles an unknown outcome that did run to the order's own result", async () => {
    const ran = {
      clientOrderId: 1n,
      orderSeq: 0n,
      filled: 1000n,
      filledNotional: 0n,
      rested: 0n,
      cancelled: 0n,
      fee: 0n,
      kind: 1,
      status: RESULT_STATUS_CODE.filled,
      code: 0,
      sentAt: 0,
      resultAt: 1,
    };
    const { rollup } = trading(async () => {
      throw new OutcomeUnknown(1n, Promise.resolve(ran), new Error("socket hang up"));
    });
    const result = await rollup.placeOrder(WALLET, ORDER as never);
    const final = await result.pending!.settled;
    expect(final.status).toBe("filled");
    expect(Number(final.filledSize)).toBe(1);
    expect(final.reason).toMatch(/Landed late/);
  });

  it("surfaces an order that ran but could not be read back as an unknown outcome, one signing attempt, one secret", async () => {
    let calls = 0;
    const { rollup, storage, builds } = trading(async () => {
      calls += 1;
      return SENT_BUT_UNREADABLE;
    });
    const failure = await rollup
      .placeOrder(WALLET, ORDER as never)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OrderOutcomeUnknownError);
    expect((failure as Error).message).toMatch(/outcome unknown.*check open orders/i);
    expect(calls).toBe(1);
    expect(builds()).toBe(1);
    const tracked = loadTrackedSecrets(storage, WALLET.address);
    expect(tracked).toHaveLength(1);
    expect((failure as OrderOutcomeUnknownError).secretHex).toBe(tracked[0].secretHex);
  });

  it("refuses with nothing held and nothing tracked when the package fails before it sends", async () => {
    for (const message of [
      "fetch failed",
      "429 Too Many Requests",
      "failed to get recent blockhash",
      "401 Missing token query param",
      "User rejected the request",
      "market 0 does not exist",
    ]) {
      let calls = 0;
      const { rollup, storage } = trading(async () => {
        calls += 1;
        throw new Error(message);
      });
      const result = await rollup.placeOrder(WALLET, ORDER as never);
      expect(result.status).toBe("rejected");
      expect(result.reason).toMatch(/^Nothing was sent\./);
      expect(result.reason).not.toContain(message);
      expect(await rollup.readUnknownOutcome(WALLET, ORDER.market)).toBeNull();
      expect(loadTrackedSecrets(storage, WALLET.address)).toHaveLength(0);
      await rollup.placeOrder(WALLET, ORDER as never);
      expect(calls).toBe(2);
    }
  });

  it("refuses a second order in the market after an unknown outcome, so two clicks send one", async () => {
    let calls = 0;
    const { rollup, storage } = trading(async () => {
      calls += 1;
      return SENT_BUT_UNREADABLE;
    });
    const first = await rollup.placeOrder(WALLET, ORDER as never).catch((error: unknown) => error);
    const second = await rollup.placeOrder(WALLET, ORDER as never).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(OrderOutcomeUnknownError);
    expect(second).toBeInstanceOf(OrderOutcomeUnknownError);
    expect((second as OrderOutcomeUnknownError).secretHex).toBe(
      (first as OrderOutcomeUnknownError).secretHex,
    );
    expect(calls).toBe(1);
    expect(loadTrackedSecrets(storage, WALLET.address)).toHaveLength(1);
  });

  it("accepts orders again once the hold is released", async () => {
    let calls = 0;
    const { rollup } = trading(async () => {
      calls += 1;
      return SENT_BUT_UNREADABLE;
    });
    await rollup.placeOrder(WALLET, ORDER as never).catch(() => {});
    rollup.releaseUnknownOutcome(WALLET, ORDER.market);
    await rollup.placeOrder(WALLET, ORDER as never).catch(() => {});
    expect(calls).toBe(2);
  });

  it("does not hold the market after a proven refusal", async () => {
    let calls = 0;
    const { rollup } = trading(async () => {
      calls += 1;
      throw new OrderInvalid("PriceOffTick");
    });
    const result = await rollup.placeOrder(WALLET, ORDER as never);
    expect(result.status).toBe("rejected");
    await rollup.placeOrder(WALLET, ORDER as never);
    expect(calls).toBe(2);
  });
});
