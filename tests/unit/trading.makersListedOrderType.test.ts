import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { keypairOwnerSigner } from "@/lib/wallet/ownerSigner";
import { RollupTradingClient } from "@/lib/trading/rollupClient";
import type { RollupSession, TraderClientLike } from "@/lib/rollup/session";
import type { PublicDeployment } from "@/lib/rollup/deployment";
import { MAINNET_PINS } from "@/lib/rollup/pins";
import { isMakersListed, ORDER_TYPE_CODE } from "@/lib/rollup/sdk";
import type { MarketInfo } from "@/lib/market-data/types";
import type { NewOrderInput, WalletIdentity } from "@/lib/trading/types";
import { limitSentAsIoc, orderCanRest, wireOrderType } from "@/lib/trading/orderType";

describe("orderCanRest", () => {
  it("lets only a limit order rest", () => {
    expect(orderCanRest("limit", false, undefined)).toBe(true);
    expect(orderCanRest("market", false, undefined)).toBe(false);
  });

  it("does not let a limit rest when makers are listed, since it is sent as immediate-or-cancel", () => {
    expect(orderCanRest("limit", true, undefined)).toBe(false);
  });

  it("never lets a reduce-only order rest, as the program cancels what does not fill", () => {
    expect(orderCanRest("limit", false, true)).toBe(false);
    expect(orderCanRest("limit", true, true)).toBe(false);
  });
});

describe("limitSentAsIoc", () => {
  it("sends a limit as immediate-or-cancel only while makers are listed", () => {
    expect(limitSentAsIoc("limit", true, undefined)).toBe(true);
    expect(limitSentAsIoc("limit", false, undefined)).toBe(false);
  });

  it("never changes a market order", () => {
    expect(wireOrderType("market", true, undefined)).toBe("market");
  });

  it("keeps the chosen type for a reduce-only order", () => {
    expect(wireOrderType("limit", true, true)).toBe("limit");
    expect(wireOrderType("limit", true, false)).toBe("immediateOrCancel");
  });
});

describe("the market's maker switch", () => {
  it("reads the maker bit and not the taker bit", () => {
    expect(isMakersListed(0)).toBe(false);
    expect(isMakersListed(1)).toBe(true);
    expect(isMakersListed(2)).toBe(false);
    expect(isMakersListed(3)).toBe(true);
  });

  it("names the program's codes: limit 0, immediate-or-cancel 2", () => {
    expect(ORDER_TYPE_CODE.limit).toBe(0);
    expect(ORDER_TYPE_CODE.immediateOrCancel).toBe(2);
  });
});

const PERP: MarketInfo = {
  id: "NSOL-PERP",
  kind: "perp",
  base: "SOL",
  quote: "USDC",
  tickSize: "0.010000",
  lotSize: "0.001000",
  maxLeverage: 10,
  markPrice: "150.000000",
  markPriceUpdatedAtMs: Date.now(),
  change24hPercent: 0,
  volume24h: "0",
  openInterest: "0",
};

const DEPLOYMENT: PublicDeployment = {
  network: "mainnet",
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

async function sentOrderType(
  input: Partial<NewOrderInput>,
  {
    mainnet,
    makersListed,
  }: { mainnet: boolean; makersListed: boolean | "unreadable" | "switchedAfterBuild" },
): Promise<number> {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
  let sent = -1;
  const unused = async () => {
    throw new Error("unused");
  };
  const client = {
    view: async () => ({}),
    subscribeView: () => async () => {},
    placeOrder: async (_market: number, order: { orderType: number }) => {
      sent = order.orderType;
      throw new Error("stop after the type is captured");
    },
    cancelOrder: unused,
    cancelAll: unused,
    syncView: unused,
    transferBetweenBalances: unused,
  } as unknown as TraderClientLike;
  const session: RollupSession = {
    owner: keypairOwnerSigner(Keypair.generate()),
    orderKeyPublicKeys: [],
    client,
    deployment: DEPLOYMENT,
    tokenIndexBySymbol: new Map(),
    collateralToken: { mint: Keypair.generate().publicKey, custodyNonce: 0n },
    gate: Keypair.generate().publicKey,
    makersListed: new Set(makersListed === true ? [0] : []),
    readMakersListed: async () => {
      if (makersListed === "unreadable") throw new Error("account read failed");
      return makersListed !== false;
    },
    tokenExpiresAtMs: Number.MAX_SAFE_INTEGER,
    saveKeyCheckpoint: () => {},
    close: () => {},
  };
  const rollup = new RollupTradingClient({
    simUrl: "http://sim.test",
    overrides: mainnet ? { pins: MAINNET_PINS, programId: MAINNET_PINS.programId } : undefined,
    marketSettingsLookup: (id) => (id === "NSOL-PERP" ? PERP : undefined),
    storage,
    buildSession: async () => session,
  });
  let failure: unknown = null;
  await rollup
    .placeOrder(WALLET, {
      market: "NSOL-PERP",
      side: "buy",
      type: "limit",
      price: "100.00",
      size: "1",
      ...input,
    })
    .catch((error: unknown) => {
      failure = error;
    });
  if (sent === -1) throw failure;
  return sent;
}

describe("the order type that reaches the program", () => {
  it("sends a limit as immediate-or-cancel on a mainnet market with the maker list on", async () => {
    expect(await sentOrderType({}, { mainnet: true, makersListed: true })).toBe(
      ORDER_TYPE_CODE.immediateOrCancel,
    );
  });

  it("sends a plain limit once the maker list is off", async () => {
    expect(await sentOrderType({}, { mainnet: true, makersListed: false })).toBe(
      ORDER_TYPE_CODE.limit,
    );
  });

  it("forces immediate-or-cancel when the market switched after the session was built", async () => {
    expect(await sentOrderType({}, { mainnet: true, makersListed: "switchedAfterBuild" })).toBe(
      ORDER_TYPE_CODE.immediateOrCancel,
    );
  });

  it("forces immediate-or-cancel when the market account cannot be read", async () => {
    expect(await sentOrderType({}, { mainnet: true, makersListed: "unreadable" })).toBe(
      ORDER_TYPE_CODE.immediateOrCancel,
    );
  });

  it("keeps a reduce-only limit as a limit under the maker list", async () => {
    expect(await sentOrderType({ reduceOnly: true }, { mainnet: true, makersListed: true })).toBe(
      ORDER_TYPE_CODE.limit,
    );
  });

  it("leaves a test build's limit alone whatever the market says", async () => {
    expect(await sentOrderType({}, { mainnet: false, makersListed: true })).toBe(
      ORDER_TYPE_CODE.limit,
    );
  });
});
