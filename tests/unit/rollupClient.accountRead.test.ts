import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { RollupTradingClient } from "@/lib/trading/rollupClient";
import type { RollupSession, TraderClientLike } from "@/lib/rollup/session";
import type { PublicDeployment } from "@/lib/rollup/deployment";
import type { MarketInfo } from "@/lib/market-data/types";
import type { TraderState, WalletIdentity } from "@/lib/trading/types";
import { VIEW_NOT_READABLE_MESSAGE, type View } from "@/lib/rollup/sdk";

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

function viewWithCollateral(collateral: bigint, resultsWritten: number): View {
  return {
    orderKeys: [],
    resultsWritten,
    results: [],
    snapshot: {
      seat: { collateral, spot: [], perp: [], openOrders: [] },
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

const OWNER = Keypair.generate();
const WALLET: WalletIdentity = {
  address: OWNER.publicKey.toBase58(),
  secretKeyHex: "aa".repeat(64),
};

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

function account(
  view: TraderClientLike["view"],
  storage: ReturnType<typeof memoryStorage> = memoryStorage(),
) {
  let push: ((view: View) => void) | null = null;
  const unused = async () => {
    throw new Error("unused");
  };
  const client: TraderClientLike = {
    view,
    subscribeView: (onChange) => {
      push = onChange;
      return async () => {};
    },
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
    createdAtMs: Date.now(),
    saveKeyCheckpoint: () => {},
    close: () => {},
  });
  const rollup = new RollupTradingClient({
    simUrl: "http://sim.test",
    storage,
    marketSettingsLookup: (id) => (id === "NSOL-PERP" ? PERP : undefined),
    buildSession: async () => session(),
  });
  const states: TraderState[] = [];
  const errors: Error[] = [];
  rollup.subscribe(
    WALLET,
    (state) => states.push(state),
    (error) => errors.push(error),
  );
  return { states, errors, pushView: (next: View) => push?.(next) };
}

describe("RollupTradingClient.subscribe: the first account read", () => {
  it("reports a failed first read as an error and shows no state, not an empty account", async () => {
    const { states, errors } = account(async () => {
      throw new Error("socket closed");
    });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0].message).toBe("socket closed");
    expect(states).toHaveLength(0);
  });

  it("shows an account that really is not open yet as empty, with no error", async () => {
    const { states, errors } = account(async () => {
      throw new Error(VIEW_NOT_READABLE_MESSAGE);
    });
    await vi.waitFor(() => expect(states).toHaveLength(1));
    expect(errors).toHaveLength(0);
    expect(states[0].balances).toEqual({});
    expect(states[0].collateral?.total).toBe("0");
  });

  it("shows a funded account's real balance once its view arrives after the failed read", async () => {
    const { states, errors, pushView } = account(async () => {
      throw new Error("socket closed");
    });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(states).toHaveLength(0);
    pushView(viewWithCollateral(5_000_000n, 1));
    expect(states).toHaveLength(1);
    expect(states[0].collateral?.total).toBe("5.000000");
  });

  it("shows a funded account's balance when the first read succeeds", async () => {
    const { states, errors } = account(async () => viewWithCollateral(5_000_000n, 1));
    await vi.waitFor(() => expect(states).toHaveLength(1));
    expect(errors).toHaveLength(0);
    expect(states[0].collateral?.total).toBe("5.000000");
  });

  it("keeps a wallet seen with an account unknown when its view reads as missing, then shows it once readable", async () => {
    const storage = memoryStorage();
    const first = account(async () => viewWithCollateral(5_000_000n, 1), storage);
    await vi.waitFor(() => expect(first.states).toHaveLength(1));

    let reads = 0;
    const second = account(async () => {
      reads += 1;
      if (reads === 1) return null as unknown as View;
      return viewWithCollateral(5_000_000n, 2);
    }, storage);
    await vi.waitFor(() => expect(second.errors).toHaveLength(1));
    expect(second.states).toHaveLength(0);
    second.pushView(viewWithCollateral(5_000_000n, 2));
    expect(second.states).toHaveLength(1);
    expect(second.states[0].collateral?.total).toBe("5.000000");
  });

  it("keeps a wallet seen with an account unknown on the SDK's not-readable answer", async () => {
    const storage = memoryStorage();
    const first = account(async () => viewWithCollateral(5_000_000n, 1), storage);
    await vi.waitFor(() => expect(first.states).toHaveLength(1));
    const second = account(async () => {
      throw new Error(VIEW_NOT_READABLE_MESSAGE);
    }, storage);
    await vi.waitFor(() => expect(second.errors).toHaveLength(1));
    expect(second.states).toHaveLength(0);
  });

  it("treats a null view as empty only for a wallet never seen with an account", async () => {
    const { states, errors } = account(async () => null as unknown as View);
    await vi.waitFor(() => expect(states).toHaveLength(1));
    expect(errors).toHaveLength(0);
    expect(states[0].balances).toEqual({});
  });
});
