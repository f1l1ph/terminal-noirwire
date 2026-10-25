import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { keypairOwnerSigner } from "@/lib/wallet/ownerSigner";
import { RollupTradingClient } from "@/lib/trading/rollupClient";
import type { RollupSession, TraderClientLike } from "@/lib/rollup/session";
import type { PublicDeployment } from "@/lib/rollup/deployment";
import type { MarketInfo } from "@/lib/market-data/types";
import type { WalletIdentity } from "@/lib/trading/types";
import { OrderOutcomeUnknownError } from "@/lib/trading/unknownOutcome";
import {
  holdClearableAtMs,
  loadHolds,
  UNKNOWN_HOLD_CLEAR_AFTER_MS,
} from "@/lib/rollup/accountMemory";
import type { View } from "@/lib/rollup/sdk";

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

const SECRET_KEY_HEX = "aa".repeat(64);
const WALLET: WalletIdentity = { address: "owner-address", secretKeyHex: SECRET_KEY_HEX };
const ORDER = {
  market: "NSOL-PERP",
  side: "sell",
  type: "market",
  price: "100.00",
  size: "1",
} as const;

function memoryStorage(failingKeyPart?: string) {
  const map = new Map<string, string>();
  const guard = (key: string) => {
    if (failingKeyPart && key.includes(failingKeyPart)) throw new Error("storage unavailable");
  };
  return {
    map,
    getItem: (key: string) => {
      guard(key);
      return map.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      guard(key);
      map.set(key, value);
    },
    removeItem: (key: string) => {
      guard(key);
      map.delete(key);
    },
  };
}

function unknownFrom(attempt: Promise<unknown>): Promise<OrderOutcomeUnknownError> {
  return attempt.then(
    () => {
      throw new Error("expected an unknown outcome");
    },
    (error: unknown) => error as OrderOutcomeUnknownError,
  );
}

/** One page load: a fresh client over `storage`, whose SDK `placeOrder` is counted and always fails after sending. */
function pageLoad(storage: ReturnType<typeof memoryStorage>) {
  let sends = 0;
  const unused = async () => {
    throw new Error("unused");
  };
  const client: TraderClientLike = {
    view: async () => VIEW,
    subscribeView: () => async () => {},
    placeOrder: async () => {
      sends += 1;
      throw new Error("socket closed");
    },
    cancelOrder: unused,
    cancelAll: unused,
    syncView: unused,
    transferBetweenBalances: unused,
  };
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
    buildSession: async () => session(),
  });
  return { rollup, sends: () => sends };
}

describe("an unknown outcome survives a reload", () => {
  it("persists the hold before the send, without any key material", async () => {
    const storage = memoryStorage();
    const { rollup } = pageLoad(storage);
    const failure = await rollup.placeOrder(WALLET, ORDER).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OrderOutcomeUnknownError);
    const held = loadHolds(storage, WALLET.address)[ORDER.market];
    expect(held).toMatchObject({
      market: "NSOL-PERP",
      side: "sell",
      type: "market",
      size: "1",
      price: "100.00",
      tag: (failure as OrderOutcomeUnknownError).secretHex,
    });
    expect(held.sentAtMs).toBeGreaterThan(0);
    expect(held.orderExpiresAtMs).toBeNull();
    const stored = [...storage.map.entries()]
      .filter(([key]) => key.includes("unknown-orders"))
      .map(([, value]) => value)
      .join("");
    expect(stored).not.toContain(SECRET_KEY_HEX);
  });

  it("refuses the second click on a new client reading the same storage", async () => {
    const storage = memoryStorage();
    const first = pageLoad(storage);
    const original = await first.rollup
      .placeOrder(WALLET, ORDER)
      .catch((error: unknown) => error as OrderOutcomeUnknownError);

    const reloaded = pageLoad(storage);
    const second = await reloaded.rollup.placeOrder(WALLET, ORDER).catch((error: unknown) => error);
    expect(second).toBeInstanceOf(OrderOutcomeUnknownError);
    expect((second as OrderOutcomeUnknownError).secretHex).toBe(
      (original as OrderOutcomeUnknownError).secretHex,
    );
    expect(first.sends()).toBe(1);
    expect(reloaded.sends()).toBe(0);
    expect((await reloaded.rollup.readUnknownOutcome(WALLET, ORDER.market))?.tag).toBe(
      (original as OrderOutcomeUnknownError).secretHex,
    );
  });

  it("accepts orders again, across a reload, once the hold is released", async () => {
    const storage = memoryStorage();
    await pageLoad(storage)
      .rollup.placeOrder(WALLET, ORDER)
      .catch(() => {});
    pageLoad(storage).rollup.releaseUnknownOutcome(WALLET, ORDER.market);
    const third = pageLoad(storage);
    await third.rollup.placeOrder(WALLET, ORDER).catch(() => {});
    expect(third.sends()).toBe(1);
    expect(loadHolds(storage, WALLET.address)[ORDER.market]).toBeDefined();
  });

  it("holds only the market it was sent in", async () => {
    const storage = memoryStorage();
    await pageLoad(storage)
      .rollup.placeOrder(WALLET, ORDER)
      .catch(() => {});
    const other = await pageLoad(storage).rollup.readUnknownOutcome(WALLET, "NETH-PERP");
    expect(other).toBeNull();
  });

  it("refuses to send when the hold cannot be written, and sends nothing", async () => {
    const storage = memoryStorage("unknown-orders");
    const { rollup, sends } = pageLoad(storage);
    const failure = await rollup.placeOrder(WALLET, ORDER).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(OrderOutcomeUnknownError);
    expect((failure as Error).message).toMatch(/not sent/);
    expect(sends()).toBe(0);
    expect(await rollup.readUnknownOutcome(WALLET, ORDER.market)).toBeNull();
  });
});

describe("holds are per wallet and per tag", () => {
  const WALLET_B: WalletIdentity = {
    address: "other-owner-address",
    secretKeyHex: "bb".repeat(64),
  };

  it("keeps each wallet's hold in the same market apart, across a reload", async () => {
    const storage = memoryStorage();
    const a = await unknownFrom(pageLoad(storage).rollup.placeOrder(WALLET, ORDER));
    const b = await unknownFrom(pageLoad(storage).rollup.placeOrder(WALLET_B, ORDER));
    expect(a.secretHex).not.toBe(b.secretHex);

    const reloaded = pageLoad(storage);
    expect((await reloaded.rollup.readUnknownOutcome(WALLET, ORDER.market))?.tag).toBe(a.secretHex);
    expect((await reloaded.rollup.readUnknownOutcome(WALLET_B, ORDER.market))?.tag).toBe(
      b.secretHex,
    );
  });

  it("never lets one wallet's record clear the other wallet's hold", async () => {
    const storage = memoryStorage();
    const a = await unknownFrom(pageLoad(storage).rollup.placeOrder(WALLET, ORDER));
    const reloaded = pageLoad(storage);
    const b = await unknownFrom(reloaded.rollup.placeOrder(WALLET_B, ORDER));

    // A's shown record names A's tag: asking to release it for B changes nothing.
    reloaded.rollup.releaseUnknownOutcome(WALLET_B, ORDER.market, a.secretHex);
    expect((await reloaded.rollup.readUnknownOutcome(WALLET_B, ORDER.market))?.tag).toBe(
      b.secretHex,
    );
    const refused = await reloaded.rollup
      .placeOrder(WALLET_B, ORDER)
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(OrderOutcomeUnknownError);
    expect(reloaded.sends()).toBe(1);

    // B's own tag releases B and leaves A held.
    reloaded.rollup.releaseUnknownOutcome(WALLET_B, ORDER.market, b.secretHex);
    expect(await reloaded.rollup.readUnknownOutcome(WALLET_B, ORDER.market)).toBeNull();
    expect((await reloaded.rollup.readUnknownOutcome(WALLET, ORDER.market))?.tag).toBe(a.secretHex);
  });
});

describe("holdClearableAtMs", () => {
  it("waits for the order's own expiry when it has one", () => {
    expect(holdClearableAtMs({ sentAtMs: 1_000, orderExpiresAtMs: 61_000 })).toBe(61_000);
  });

  it("otherwise waits a fixed time after the send", () => {
    expect(UNKNOWN_HOLD_CLEAR_AFTER_MS).toBe(120_000);
    expect(holdClearableAtMs({ sentAtMs: 1_000, orderExpiresAtMs: null })).toBe(121_000);
  });
});
