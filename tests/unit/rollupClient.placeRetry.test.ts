import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { RollupTradingClient } from "@/lib/trading/rollupClient";
import type { RollupSession, TraderClientLike } from "@/lib/rollup/session";
import type { PublicDeployment } from "@/lib/rollup/deployment";
import type { MarketInfo } from "@/lib/market-data/types";
import type { WalletIdentity } from "@/lib/trading/types";
import { loadTrackedSecrets } from "@/lib/rollup/secretStore";
import { OutcomeUnknown, RESULT_STATUS_CODE, type View } from "@/lib/rollup/sdk";

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

function trading(placeOrder: TraderClientLike["placeOrder"]) {
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
    owner: Keypair.generate(),
    orderKeyPublicKeys: [],
    client,
    deployment: DEPLOYMENT,
    tokenIndexBySymbol: new Map([["nUSD", 0]]),
    createdAtMs: Date.now(),
    saveKeyCheckpoint: () => {},
    close: () => {},
  });
  const rollup = new RollupTradingClient({
    simUrl: "http://sim.test",
    marketSettingsLookup: (id) => (id === "NSOL-PERP" ? PERP : undefined),
    storage,
    buildSession: async () => {
      builds += 1;
      return session();
    },
  });
  return { rollup, storage, builds: () => builds };
}

describe("placeOrder: retries only what was never sent", () => {
  it("retries once, against a fresh session, an order whose send never started", async () => {
    let calls = 0;
    const { rollup, storage, builds } = trading(async () => {
      calls += 1;
      if (calls === 1) throw new Error("401 Missing token query param");
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
    });
    const result = await rollup.placeOrder(WALLET, ORDER as never);
    expect(calls).toBe(2);
    expect(builds()).toBe(2);
    expect(result.status).toBe("filled");
    // Only the attempt that was sent keeps its secret.
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
});
