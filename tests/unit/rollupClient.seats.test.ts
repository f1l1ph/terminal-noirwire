import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { transactionFailure } from "@noirwire/orderbook";
import { keypairOwnerSigner } from "@/lib/wallet/ownerSigner";
import { RollupTradingClient } from "@/lib/trading/rollupClient";
import type { RollupSession, TraderClientLike } from "@/lib/rollup/session";
import type { PublicDeployment } from "@/lib/rollup/deployment";
import type { MarketInfo } from "@/lib/market-data/types";
import type { TraderState, WalletIdentity } from "@/lib/trading/types";
import { RESULT_STATUS_CODE, type OrderResult, type Placed, type View } from "@/lib/rollup/sdk";
import { describeProgramError, PROGRAM_ERROR } from "@/lib/rollup/refusals";

const USDC = 1_000_000n;
const OWNER = Keypair.generate();
const WALLET: WalletIdentity = {
  address: OWNER.publicKey.toBase58(),
  secretKeyHex: "aa".repeat(64),
};
const ORDER = { market: "NSOL-PERP", side: "sell", type: "market", price: "100.00", size: "1" };

function perp(id: string): MarketInfo {
  return {
    id,
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
}

function deploymentMarket(marketId: number, symbol: string, baseDecimals: number, lot: string) {
  return {
    marketId,
    symbol,
    kind: "perp" as const,
    market: Keypair.generate().publicKey.toBase58(),
    tape: Keypair.generate().publicKey.toBase58(),
    priceFeed: Keypair.generate().publicKey.toBase58(),
    baseToken: null,
    quoteToken: { symbol: "nUSD", mint: Keypair.generate().publicKey.toBase58(), decimals: 6 },
    baseDecimals,
    quoteDecimals: 6,
    lotSize: lot,
    tick: "100",
  };
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
    deploymentMarket(0, "NSOL-PERP", 9, "1000000"),
    deploymentMarket(1, "NNVDA-PERP", 6, "1000"),
  ],
};

interface ViewOptions {
  resultsWritten?: number;
  seatRecorded?: boolean;
  snapshotOld?: boolean;
  collateral?: bigint;
  /** The seat's tagged slots, in slot order. */
  positions?: { marketId: number; base: bigint; quote: bigint }[];
}

function viewWith(options: ViewOptions = {}): View {
  return {
    orderKeys: [],
    resultsWritten: options.resultsWritten ?? 1,
    results: [],
    seatRecorded: options.seatRecorded ?? true,
    snapshotOld: options.snapshotOld ?? false,
    snapshot: {
      seat: {
        collateral: options.collateral ?? 500n * USDC,
        spot: [],
        positions: (options.positions ?? []).map((position) => ({
          openBidLots: 0n,
          openAskLots: 0n,
          openOrders: 0,
          fundingCheckpoint: 0n,
          ...position,
        })),
      },
      marketId: 0,
      orders: [],
    },
  } as unknown as View;
}

function resultWith(code: number, status = RESULT_STATUS_CODE.refused): OrderResult {
  return {
    clientOrderId: 1n,
    orderSeq: 0n,
    filled: 0n,
    filledNotional: 0n,
    rested: 0n,
    cancelled: 0n,
    fee: 0n,
    kind: 1,
    status,
    code,
  } as OrderResult;
}

function refusedPlaced(code: number): Placed {
  return {
    outcome: "placed",
    clientOrderId: 1n,
    result: resultWith(code),
    secret: new Uint8Array(16),
    view: viewWith({ resultsWritten: 2 }),
    sentAt: 0,
    resultAt: 1,
  } as Placed;
}

function trading(overrides: Partial<TraderClientLike>, views: View[] = [viewWith()]) {
  const map = new Map<string, string>();
  const unused = async () => {
    throw new Error("unused");
  };
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
    owner: keypairOwnerSigner(OWNER),
    orderKeyPublicKeys: [],
    client,
    deployment: DEPLOYMENT,
    tokenIndexBySymbol: new Map([["nUSD", 0]]),
    collateralToken: { mint: Keypair.generate().publicKey, custodyNonce: 0n },
    gate: Keypair.generate().publicKey,
    tokenExpiresAtMs: Number.MAX_SAFE_INTEGER,
    saveKeyCheckpoint: () => {},
    close: () => {},
  };
  return new RollupTradingClient({
    simUrl: "http://sim.test",
    marketSettingsLookup: (id) => perp(id),
    storage: {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => void map.set(key, value),
      removeItem: (key) => void map.delete(key),
    },
    buildSession: async () => session,
  });
}

/** A `confirmSeat` that answers with each view in turn, the last one repeating; it holds a seat unless the view records none. */
function confirmingAs(...views: View[]) {
  let call = 0;
  return vi.fn(async () => {
    const view = views[Math.min(call++, views.length - 1)];
    return { seated: view.seatRecorded, view };
  });
}

const notSeated = () =>
  transactionFailure("sig", {
    InstructionError: [0, { Custom: 6000 + PROGRAM_ERROR.notSeated }],
  });

describe("an account that holds no seat", () => {
  it("shows zero everywhere and says it is unseated", async () => {
    const rollup = trading({}, [viewWith({ seatRecorded: false, collateral: 0n })]);
    const state = await rollup.fetchState(WALLET);
    expect(state.unseated).toBe(true);
    expect(state.collateral?.total).toBe("0");
    expect(state.equity).toBe("0");
    expect(state.positions).toEqual({});
    expect(state.openOrders).toEqual([]);
  });

  it("does not call a seated account unseated", async () => {
    const state = await trading({}).fetchState(WALLET);
    expect(state.unseated).toBeUndefined();
    expect(state.collateral?.total).toBe("500.000000");
  });
});

describe("positions are read by the market their slot is tagged with", () => {
  it("finds a position held in the seat's first slot under the market that slot is tagged with", async () => {
    const held = viewWith({ positions: [{ marketId: 1, base: 10_000n, quote: -1000n * USDC }] });
    const state = await trading({}, [held]).fetchState(WALLET);
    expect(state.positions["NNVDA-PERP"]).toMatchObject({ size: "10.000" });
    expect(state.positions["NSOL-PERP"]).toBeUndefined();
  });

  it("treats a market with no slot as flat", async () => {
    const state = await trading({}, [viewWith({ positions: [] })]).fetchState(WALLET);
    expect(state.positions).toEqual({});
    expect(state.exposureUnreadable).toBeUndefined();
  });
});

describe("a snapshot written before the seat layout changed", () => {
  it("is rewritten by a sync_view before anything is shown, and never closes or releases", async () => {
    const written = viewWith({ resultsWritten: 2, collateral: 250n * USDC });
    const confirmSeat = vi.fn(async () => ({ seated: true, view: written }));
    const syncView = vi.fn();
    const rollup = trading({ confirmSeat, syncView: syncView as never }, [
      viewWith({ snapshotOld: true, collateral: 999n * USDC }),
    ]);
    const state = await rollup.fetchState(WALLET);
    expect(confirmSeat).toHaveBeenCalled();
    expect(syncView).not.toHaveBeenCalled();
    expect(state.collateral?.total).toBe("250.000000");
    expect(state.unseated).toBeUndefined();
  });

  it("is never shown while the refresh has not come back", async () => {
    const rollup = trading(
      {
        confirmSeat: async () => {
          throw new Error("offline");
        },
      },
      [viewWith({ snapshotOld: true, collateral: 999n * USDC })],
    );
    await expect(rollup.fetchState(WALLET)).rejects.toThrow(/offline/);
  });

  it("is refreshed when the subscription pushes it, and the old figures are not emitted", async () => {
    let push: (view: View) => void = () => {};
    const rollup = trading(
      {
        subscribeView: (onChange) => {
          push = onChange;
          return async () => {};
        },
        confirmSeat: confirmingAs(
          viewWith(),
          viewWith({ resultsWritten: 3, collateral: 250n * USDC }),
        ),
      },
      [viewWith()],
    );
    const states: TraderState[] = [];
    rollup.subscribe(WALLET, (state) => states.push(state));
    await vi.waitFor(() => expect(states).toHaveLength(1));
    push(viewWith({ resultsWritten: 2, snapshotOld: true, collateral: 999n * USDC }));
    await vi.waitFor(() => expect(states).toHaveLength(2));
    expect(states.map((state) => state.collateral?.total)).toEqual(["500.000000", "250.000000"]);
  });
});

describe("an order refused because the account holds no seat", () => {
  it("refreshes the view, shows the account empty and tells the owner to deposit", async () => {
    const confirmSeat = confirmingAs(
      viewWith(),
      viewWith({ resultsWritten: 2, seatRecorded: false, collateral: 0n }),
    );
    const rollup = trading({
      confirmSeat,
      placeOrder: async () => {
        throw notSeated();
      },
    });
    const states: TraderState[] = [];
    rollup.subscribe(WALLET, (state) => states.push(state));
    await vi.waitFor(() => expect(states).toHaveLength(1));
    const result = await rollup.placeOrder(WALLET, ORDER as never);
    expect(result.status).toBe("rejected");
    expect(result.reason).toBe(describeProgramError(PROGRAM_ERROR.notSeated));
    expect(result.reason).toMatch(/Deposit to start trading/);
    expect(confirmSeat).toHaveBeenCalledTimes(2);
    expect(states.at(-1)?.unseated).toBe(true);
  });

  it("does the same for a refusal written to the result ring", async () => {
    const confirmSeat = confirmingAs(
      viewWith(),
      viewWith({ resultsWritten: 3, seatRecorded: false, collateral: 0n }),
    );
    const rollup = trading({
      confirmSeat,
      placeOrder: async () => refusedPlaced(PROGRAM_ERROR.notSeated),
    });
    const result = await rollup.placeOrder(WALLET, ORDER as never);
    expect(result.reason).toMatch(/Deposit to start trading/);
    await vi.waitFor(() => expect(confirmSeat).toHaveBeenCalledTimes(2));
  });

  it("does not ask the exchange about the seat for any other refusal", async () => {
    const confirmSeat = confirmingAs(viewWith());
    const rollup = trading({
      confirmSeat,
      placeOrder: async () => refusedPlaced(PROGRAM_ERROR.insufficientMargin),
    });
    await rollup.placeOrder(WALLET, ORDER as never);
    await vi.waitFor(() => expect(confirmSeat).toHaveBeenCalled());
    expect(confirmSeat).toHaveBeenCalledTimes(1);
  });
});

describe("a seat released after the view was last synced", () => {
  const stale = () => viewWith({ collateral: 999n * USDC });

  it("is confirmed before the first seated view of a session is shown, so the old balance never appears", async () => {
    const confirmSeat = confirmingAs(
      viewWith({ resultsWritten: 2, seatRecorded: false, collateral: 0n }),
    );
    const rollup = trading({ confirmSeat }, [stale()]);
    const states: TraderState[] = [];
    rollup.subscribe(WALLET, (state) => states.push(state));
    await vi.waitFor(() => expect(states).toHaveLength(1));
    expect(states[0].unseated).toBe(true);
    expect(states.map((state) => state.collateral?.total)).not.toContain("999.000000");
    expect((await rollup.fetchState(WALLET)).unseated).toBe(true);
    expect(confirmSeat).toHaveBeenCalledTimes(1);
  });

  it("shows nothing when the confirmation fails, and never the old numbers", async () => {
    const rollup = trading(
      {
        confirmSeat: async () => {
          throw new Error("offline");
        },
      },
      [stale()],
    );
    const states: TraderState[] = [];
    const errors: Error[] = [];
    rollup.subscribe(
      WALLET,
      (state) => states.push(state),
      (error) => errors.push(error),
    );
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(states).toEqual([]);
    await expect(rollup.fetchState(WALLET)).rejects.toThrow(/offline/);
  });

  it("is not shown from a pushed view either until the session has confirmed", async () => {
    let push: (view: View) => void = () => {};
    const confirmSeat = confirmingAs(viewWith({ resultsWritten: 4, collateral: 5n * USDC }));
    const rollup = trading(
      {
        subscribeView: (onChange) => {
          push = onChange;
          return async () => {};
        },
        confirmSeat,
        view: async () => {
          throw new Error("offline");
        },
      },
      [stale()],
    );
    const states: TraderState[] = [];
    rollup.subscribe(
      WALLET,
      (state) => states.push(state),
      () => {},
    );
    await vi.waitFor(() => expect(confirmSeat).not.toHaveBeenCalled());
    push(viewWith({ resultsWritten: 3, collateral: 999n * USDC }));
    await vi.waitFor(() => expect(states).toHaveLength(1));
    expect(states[0].collateral?.total).toBe("5.000000");
  });
});

describe("an order on a fifth market", () => {
  it("says an account holds four markets at once and to close one", async () => {
    const rollup = trading({
      placeOrder: async () => refusedPlaced(PROGRAM_ERROR.slotsFull),
    });
    const result = await rollup.placeOrder(WALLET, ORDER as never);
    expect(result.status).toBe("rejected");
    expect(result.reason).toBe(
      "You can hold positions or orders in up to 4 markets at once. Close one to trade here.",
    );
  });

  it("says the same when the transaction itself fails with it", async () => {
    const rollup = trading({
      placeOrder: async () => {
        throw transactionFailure("sig", {
          InstructionError: [0, { Custom: 6000 + PROGRAM_ERROR.slotsFull }],
        });
      },
    });
    const result = await rollup.placeOrder(WALLET, ORDER as never);
    expect(result.reason).toMatch(/up to 4 markets at once/);
  });
});
