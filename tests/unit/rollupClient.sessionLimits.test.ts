import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { keypairOwnerSigner } from "@/lib/wallet/ownerSigner";
import { RollupTradingClient } from "@/lib/trading/rollupClient";
import type { ChainMarketLimits, RollupSession, TraderClientLike } from "@/lib/rollup/session";
import type { PublicDeployment } from "@/lib/rollup/deployment";
import type { MarketInfo } from "@/lib/market-data/types";
import type { NewOrderInput, WalletIdentity } from "@/lib/trading/types";
import type { View } from "@/lib/rollup/sdk";

const PERP: MarketInfo = {
  id: "NSOL-PERP",
  kind: "perp",
  base: "SOL",
  quote: "USDC",
  tickSize: "0.010000",
  lotSize: "0.001000",
  maxLeverage: 5,
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
      quoteToken: { symbol: "USDC", mint: Keypair.generate().publicKey.toBase58(), decimals: 6 },
      baseDecimals: 9,
      quoteDecimals: 6,
      lotSize: "1000000",
      tick: "100",
    },
  ],
};

const WALLET: WalletIdentity = { address: "owner-address", secretKeyHex: "aa".repeat(64) };
/** 4% above the 150 mark: inside a 400 bps band, outside a 200 bps one. */
const REVIEWED_BID: NewOrderInput = {
  market: "NSOL-PERP",
  side: "buy",
  type: "market",
  price: "156.00",
  size: "1",
};

const limitsOf = (bandBps: number, minSize = 1n, minNotional = 0n) =>
  new Map<number, ChainMarketLimits>([
    [
      0,
      {
        imBps: 2000,
        mmBps: 500,
        takerFeeBps: 5,
        bandBps,
        minSize,
        minNotional,
        positionCap: 10_000n,
        maxOpenOrders: 32,
      },
    ],
  ]);

/** The first session is about to lapse, so placing an order replaces it; the second reads the given limits. */
function trading(
  first: ChainMarketLimits["bandBps"],
  second: ChainMarketLimits["bandBps"],
  secondMinSize = 1n,
  secondMinNotional = 0n,
) {
  let sent = 0;
  const unused = async () => {
    throw new Error("unused");
  };
  const client: TraderClientLike = {
    view: async () => VIEW,
    subscribeView: () => async () => {},
    placeOrder: async () => {
      sent += 1;
      throw new Error("sent");
    },
    cancelOrder: unused,
    cancelAll: unused,
    syncView: unused,
    transferBetweenBalances: unused,
  };
  let builds = 0;
  const rollup = new RollupTradingClient({
    simUrl: "http://sim.test",
    marketSettingsLookup: (id) => (id === "NSOL-PERP" ? PERP : undefined),
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    now: () => 1_000,
    buildSession: async (): Promise<RollupSession> => {
      builds += 1;
      return {
        owner: keypairOwnerSigner(Keypair.generate()),
        orderKeyPublicKeys: [],
        client,
        deployment: DEPLOYMENT,
        tokenIndexBySymbol: new Map([["USDC", 0]]),
        collateralToken: { mint: Keypair.generate().publicKey, custodyNonce: 0n },
        gate: Keypair.generate().publicKey,
        limits: builds === 1 ? limitsOf(first) : limitsOf(second, secondMinSize, secondMinNotional),
        tokenExpiresAtMs: builds === 1 ? 1_000 : Number.MAX_SAFE_INTEGER,
        saveKeyCheckpoint: () => {},
        close: () => {},
      };
    },
  });
  return { rollup, sent: () => sent, builds: () => builds };
}

describe("placeOrder checks the order against the session that sends it", () => {
  it("sends nothing when a refresh during the submit lands on a tighter band", async () => {
    const { rollup, sent, builds } = trading(400, 200);
    const result = await rollup.placeOrder(WALLET, REVIEWED_BID);
    expect(builds()).toBe(2);
    expect(sent()).toBe(0);
    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("The market settings changed. Review the order again.");
    expect(result.tag).toBe("");
  });

  it("sends the same order when the new session's band still allows it", async () => {
    const { rollup, sent, builds } = trading(400, 400);
    await rollup.placeOrder(WALLET, REVIEWED_BID).catch(() => {});
    expect(builds()).toBe(2);
    expect(sent()).toBe(1);
  });

  it("holds back an order under the new session's minimum size or value", async () => {
    // The order is 1000 lots at 156 (156 per unit, so 156 USDC).
    const size = trading(400, 400, 5_000n);
    expect((await size.rollup.placeOrder(WALLET, REVIEWED_BID)).reason).toBe(
      "The market settings changed. Review the order again.",
    );
    expect(size.sent()).toBe(0);
    const value = trading(400, 400, 1n, 1_000_000_000_000n);
    await value.rollup.placeOrder(WALLET, REVIEWED_BID);
    expect(value.sent()).toBe(0);
  });
});
