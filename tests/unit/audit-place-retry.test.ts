import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { RollupTradingClient } from "@/lib/trading/rollupClient";
import type { RollupSession, TraderClientLike } from "@/lib/rollup/session";
import type { PublicDeployment } from "@/lib/rollup/deployment";
import type { MarketInfo } from "@/lib/market-data/types";
import type { WalletIdentity } from "@/lib/trading/types";
import { OutcomeUnknown, type View } from "@/lib/rollup/sdk";

/**
 * The package's `placeOrder` throws `OutcomeUnknown` (it does not only
 * return `outcome: "unknown"`) when a send or a read fails after the signed
 * transaction went out: node_modules/@noirwire/orderbook/dist/client.js,
 * `confirmed()`, the final catch. The order may still land. The terminal
 * must not place a second order in response.
 */

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

const memoryStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
};

describe("audit: placeOrder after a post-send failure", () => {
  it("sends exactly one order and reports it as pending when the package throws OutcomeUnknown", async () => {
    let placeCalls = 0;
    const client: TraderClientLike = {
      view: async () => VIEW,
      subscribeView: () => async () => {},
      placeOrder: async () => {
        placeCalls += 1;
        throw new OutcomeUnknown(1n, new Promise(() => {}), new Error("socket hang up"));
      },
      cancelOrder: async () => {
        throw new Error("unused");
      },
      cancelAll: async () => {
        throw new Error("unused");
      },
      syncView: async () => {
        throw new Error("unused");
      },
      transferBetweenBalances: async () => {
        throw new Error("unused");
      },
    };
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
    const trading = new RollupTradingClient({
      simUrl: "http://sim.test",
      marketSettingsLookup: (id) => (id === "NSOL-PERP" ? PERP : undefined),
      storage: memoryStorage(),
      buildSession: async () => session(),
    });

    const outcome = await trading
      .placeOrder(WALLET, {
        market: "NSOL-PERP",
        side: "sell",
        type: "market",
        price: "100.00",
        size: "1",
      })
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );

    expect(placeCalls).toBe(1);
    expect("result" in outcome && outcome.result.pending).toBeTruthy();
  });
});
