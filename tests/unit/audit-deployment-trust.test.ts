import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { keypairOwnerSigner } from "@/lib/wallet/ownerSigner";
import { RollupTradingClient } from "@/lib/trading/rollupClient";
import { fetchDeployment, type PublicDeployment } from "@/lib/rollup/deployment";
import type { RollupSession, TraderClientLike } from "@/lib/rollup/session";
import type { MarketInfo } from "@/lib/market-data/types";
import type { WalletIdentity } from "@/lib/trading/types";
import { RESULT_STATUS_CODE, type View } from "@/lib/rollup/sdk";

/**
 * Lot size and base decimals that turn a typed size into on-chain lots come
 * from sim-noirwire's `/v1/deployment`, not from the market account on the
 * rollup (which carries `baseLot`, see decodeMarket in the package). The
 * same typed order is signed at 1000x the size when the service reports
 * different decimals.
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

function deploymentWith(baseDecimals: number): PublicDeployment {
  return {
    network: "devnet",
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
        baseDecimals,
        quoteDecimals: 6,
        lotSize: "1000000",
        tick: "1",
      },
    ],
  };
}

async function signedSizeFor(
  deployment: PublicDeployment,
): Promise<{ size: bigint; price: bigint }> {
  let captured: { size: bigint; price: bigint } | null = null;
  const client: TraderClientLike = {
    view: async () => VIEW,
    subscribeView: () => async () => {},
    placeOrder: async (_market, order) => {
      captured = { size: order.size, price: order.price };
      return {
        outcome: "placed",
        clientOrderId: 1n,
        result: {
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
        },
        secret: new Uint8Array(16),
        view: VIEW,
        sentAt: 0,
        resultAt: 1,
      } as never;
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
  const session: RollupSession = {
    owner: keypairOwnerSigner(Keypair.generate()),
    orderKeyPublicKeys: [],
    client,
    deployment,
    tokenIndexBySymbol: new Map(),
    collateralToken: { mint: Keypair.generate().publicKey, custodyNonce: 0n },
    gate: Keypair.generate().publicKey,
    tokenExpiresAtMs: Number.MAX_SAFE_INTEGER,
    saveKeyCheckpoint: () => {},
    close: () => {},
  };
  const map = new Map<string, string>();
  const trading = new RollupTradingClient({
    simUrl: "http://sim.test",
    marketSettingsLookup: (id) => (id === "NSOL-PERP" ? PERP : undefined),
    storage: {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
    },
    buildSession: async () => session,
  });
  const wallet: WalletIdentity = { address: "owner", secretKeyHex: "aa".repeat(64) };
  await trading.placeOrder(wallet, {
    market: "NSOL-PERP",
    side: "sell",
    type: "market",
    price: "150",
    size: "1",
  });
  return captured!;
}

describe("audit: the sim service decides how a typed order is scaled on chain", () => {
  it("a typed size of 1 is signed as the same number of lots whatever the service reports", async () => {
    const honest = await signedSizeFor(deploymentWith(9));
    const tampered = await signedSizeFor(deploymentWith(12));
    expect(tampered.size).toBe(honest.size);
  });
});

const noWait = async () => {};

describe("audit: deployment cache", () => {
  it("a transient /v1/deployment failure is not cached for the life of the page", async () => {
    let calls = 0;
    const body = deploymentWith(9);
    const fetchFn = (async () => {
      calls += 1;
      if (calls <= 3) throw new TypeError("network blip");
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;

    await fetchDeployment("https://sim-cache.example", {}, fetchFn, noWait).catch(() => null);
    const second = await fetchDeployment("https://sim-cache.example", {}, fetchFn, noWait).then(
      (value) => value.network,
      () => "still failing",
    );
    expect(second).toBe("devnet");
  });

  it("asks again, with growing waits, when the service is unreachable or busy", async () => {
    let calls = 0;
    const waits: number[] = [];
    const body = deploymentWith(9);
    const fetchFn = (async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("network blip");
      if (calls === 2) return new Response("busy", { status: 503 });
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const described = await fetchDeployment(
      "https://sim-retry.example",
      {},
      fetchFn,
      async (ms) => {
        waits.push(ms);
      },
    );
    expect(described.network).toBe("devnet");
    expect(calls).toBe(3);
    expect(waits).toEqual([1_000, 2_000]);
  });

  it("gives up after three tries and says what the service answered", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return new Response("down", { status: 502 });
    }) as typeof fetch;
    await expect(fetchDeployment("https://sim-down.example", {}, fetchFn, noWait)).rejects.toThrow(
      /answered 502/,
    );
    expect(calls).toBe(3);
  });

  it("does not repeat an answer that will not change", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return new Response("nope", { status: 404 });
    }) as typeof fetch;
    await expect(
      fetchDeployment("https://sim-missing.example", {}, fetchFn, noWait),
    ).rejects.toThrow(/answered 404/);
    expect(calls).toBe(1);
  });
});
