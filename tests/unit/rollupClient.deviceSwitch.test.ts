import { describe, expect, it } from "vitest";
import { Keypair, type Connection, type PublicKey } from "@solana/web3.js";
import { keypairOwnerSigner } from "@/lib/wallet/ownerSigner";
import { RollupTradingClient } from "@/lib/trading/rollupClient";
import { holdsKeysOf, type RollupSession, type TraderClientLike } from "@/lib/rollup/session";
import type { OrderKeyStatus } from "@/lib/rollup/orderKeySetup";
import type { OrderKeyState, WalletIdentity } from "@/lib/trading/types";
import { freshOrderKeys, VIEW_NOT_READABLE_MESSAGE, type View } from "@/lib/rollup/sdk";
import { KEYS_AWAY_REASON } from "@/lib/rollup/outcome";
import { PROGRAM_ERROR } from "@/lib/rollup/refusals";
import {
  keysOf,
  memoryStore,
  PERP_MARKET as PERP,
  programRefusal,
  SEED,
  settle,
  singleMarketDeployment,
  stages,
  STRANGER_SEED,
  USDC,
} from "./support/rollupFixtures";

const strangersKeys = () => keysOf(STRANGER_SEED, [0, 1, 2, 3]);
const ownKeys = () => keysOf(SEED, [0, 1, 2, 3]);
const movedKeys = () => keysOf(SEED, [4, 5, 6, 7]);
const sameSeedOtherTab = () => keysOf(SEED, [10, 11, 12, 13]);
const names = (keys: PublicKey[]) => new Set(keys.map((key) => key.toBase58()));

function viewOf(orderKeys: PublicKey[], resultsWritten: number, seatRecorded = true): View {
  return {
    orderKeys,
    resultsWritten,
    results: [],
    seatRecorded,
    snapshotOld: false,
    snapshot: {
      seat: {
        collateral: 500n * USDC,
        spot: [],
        positions: [{ marketId: 0, base: 0n, quote: 0n, openBidLots: 0n, openAskLots: 0n }],
      },
      marketId: 0,
      orders: [],
    },
  } as unknown as View;
}

const DEPLOYMENT = singleMarketDeployment();

const ORDER = { market: "NSOL-PERP", side: "sell", type: "market", price: "100.00", size: "1" };
const TRIGGER = { kind: "stopLoss", price: "90", worstPrice: "89", size: null } as never;

interface WorldOptions {
  /** The keys the account's view holds at the start. */
  viewKeys: PublicKey[];
  /** Whether the session was built holding them. A false build is away from the start. */
  held: boolean;
  seatRecorded?: boolean;
  /** Withheld until released: the session build stays running. */
  gate?: Promise<void>;
  /** What the fake's `moveKeysHere` does; it installs `movedKeys()` first unless it throws before. */
  moveKeysHere?: (install: () => void) => Promise<void>;
  /** Whether the fake carries the optional away-aware methods; a fake that omits them counts as holding. */
  awareSession?: boolean;
  /** No view at all: the account is not opened. */
  noView?: boolean;
}

/**
 * A client over a fake session. The fake's "live keys" are `live`; a move
 * installs `movedKeys()` into both the view and the live set, as the real
 * session does.
 */
function world(options: WorldOptions) {
  const owner = keypairOwnerSigner(Keypair.generate());
  const wallet: WalletIdentity = { address: owner.publicKey.toBase58() };
  const sent: string[] = [];
  const statuses: OrderKeyStatus[] = [];
  const counts = { builds: 0, moves: 0, resyncs: 0 };
  let live = options.held ? names(options.viewKeys) : names(ownKeys());
  let viewNow = viewOf(options.viewKeys, 1, options.seatRecorded ?? true);
  let push: (view: View) => void = () => {};

  const record = (name: string) => async () => {
    sent.push(name);
    throw new Error("sent");
  };
  const client: TraderClientLike = {
    view: async () => {
      if (options.noView) throw new Error(VIEW_NOT_READABLE_MESSAGE);
      return viewNow;
    },
    subscribeView: (onChange) => {
      push = onChange;
      return async () => {};
    },
    placeOrder: record("place") as never,
    cancelOrder: record("cancel") as never,
    cancelAll: record("cancelAll") as never,
    setTrigger: record("setTrigger") as never,
    cancelTrigger: record("cancelTrigger") as never,
    syncView: record("sync") as never,
    withdrawByKey: record("withdraw") as never,
    confirmSeat: async () => {
      sent.push("confirmSeat");
      return { seated: true, view: viewNow };
    },
    transferBetweenBalances: record("transfer") as never,
  };
  const install = () => {
    live = names(movedKeys());
    viewNow = viewOf(movedKeys(), viewNow.resultsWritten + 1, viewNow.seatRecorded);
  };
  const seedIndices = Array.from({ length: 30 }, (_, index) => index);
  const seedKeyNames = names(keysOf(SEED, seedIndices));
  const makeSession = (): RollupSession => ({
    owner,
    orderKeyPublicKeys: [],
    client,
    reader: {} as Connection,
    deployment: DEPLOYMENT,
    tokenIndexBySymbol: new Map([["nUSD", 0]]),
    collateralToken: { mint: Keypair.generate().publicKey, custodyNonce: 0n },
    gate: Keypair.generate().publicKey,
    triggersLive: true,
    tokenExpiresAtMs: Number.MAX_SAFE_INTEGER,
    saveKeyCheckpoint: () => {},
    resyncKeys: (view) => {
      counts.resyncs += 1;
      live = names(view.orderKeys);
    },
    ...(options.awareSession === false
      ? {}
      : {
          heldAtBuild: options.held,
          holdsKeysOf: (view: Pick<View, "orderKeys">) =>
            view.orderKeys.some((key) => live.has(key.toBase58())),
          keysFromThisSeed: (view: Pick<View, "orderKeys">) =>
            view.orderKeys.every((key) => seedKeyNames.has(key.toBase58())),
          moveKeysHere: async () => {
            counts.moves += 1;
            if (options.moveKeysHere) return options.moveKeysHere(install);
            install();
          },
        }),
    close: () => {},
  });
  const rollup = new RollupTradingClient({
    simUrl: "http://sim.test",
    marketSettingsLookup: (id) => (id === "NSOL-PERP" ? PERP : undefined),
    storage: memoryStore(),
    buildSession: async (_wallet, deps) => {
      counts.builds += 1;
      await options.gate;
      if (options.held) deps.onOrderKeys?.({ stage: "ready" });
      else deps.onOrderKeys?.({ stage: "elsewhere", cancelsStops: false });
      return makeSession();
    },
  });
  rollup.subscribeOrderKeys(wallet, (state: OrderKeyState) => statuses.push(state));
  const traderStates: unknown[] = [];
  return {
    rollup,
    wallet,
    sent,
    statuses,
    counts,
    traderStates,
    client,
    start: () => rollup.subscribe(wallet, (state) => traderStates.push(state)),
    push: (view: View) => push(view),
    setView: (view: View) => {
      viewNow = view;
    },
    viewNow: () => viewNow,
  };
}

/** A world whose first session is built and subscribed, with the pending work run out. */
async function started(options: WorldOptions) {
  const w = world(options);
  w.start();
  await settle();
  return w;
}

/** Every key-signed path, with what each one returns while the session is away. */
async function expectEveryKeyPathRefused(w: ReturnType<typeof world>) {
  expect(await w.rollup.placeOrder(w.wallet, ORDER as never)).toMatchObject({
    status: "rejected",
    reason: KEYS_AWAY_REASON,
  });
  expect(await w.rollup.cancelOrder(w.wallet, "NSOL-PERP", "7")).toEqual({
    cancelled: 0,
    reason: KEYS_AWAY_REASON,
  });
  expect(await w.rollup.cancelAllInMarket(w.wallet, "NSOL-PERP")).toEqual({
    cancelled: 0,
    reason: KEYS_AWAY_REASON,
  });
  expect(await w.rollup.setTrigger(w.wallet, "NSOL-PERP", TRIGGER)).toEqual({
    kind: "refused",
    reason: KEYS_AWAY_REASON,
  });
  expect(await w.rollup.cancelTrigger(w.wallet, "NSOL-PERP", "stopLoss")).toEqual({
    kind: "refused",
    reason: KEYS_AWAY_REASON,
  });
  expect(await w.rollup.transferBetweenBalances(w.wallet, true, "1")).toEqual({
    kind: "error",
    message: KEYS_AWAY_REASON,
  });
  expect(await w.rollup.withdrawByKey(w.wallet, 1n)).toEqual({
    kind: "refused",
    code: PROGRAM_ERROR.notOrderKey,
  });
  expect(await w.rollup.syncMarket(w.wallet, "NSOL-PERP")).toBe(false);
}

describe("a session built while trading is on another device", () => {
  it("emits elsewhere, and the account still reads as open without hanging", async () => {
    const w = await started({ viewKeys: strangersKeys(), held: false });
    expect(stages(w.statuses).at(-1)).toBe("elsewhere");
    expect(stages(w.statuses)).not.toContain("ready");
    expect(await w.rollup.accountStatus(w.wallet)).toBe("open");
    expect(w.traderStates).toEqual([]);
  });

  it("still serves the rollup reader, market limits and maker status", async () => {
    const w = await started({ viewKeys: strangersKeys(), held: false });
    await expect(w.rollup.rollupReader(w.wallet)).resolves.toBeDefined();
    await expect(w.rollup.marketLimits(w.wallet)).resolves.toBeInstanceOf(Map);
    await expect(w.rollup.makersListedMarkets(w.wallet)).resolves.toBeInstanceOf(Set);
  });

  it("refuses every key path with the away reason and sends nothing", async () => {
    const w = await started({ viewKeys: strangersKeys(), held: false });
    w.sent.length = 0;
    await expectEveryKeyPathRefused(w);
    expect(w.sent).toEqual([]);
  });

  it("throws from confirmSeat instead of answering false, and sends nothing", async () => {
    const w = await started({ viewKeys: strangersKeys(), held: false });
    w.sent.length = 0;
    await expect(w.rollup.confirmSeat(w.wallet)).rejects.toThrow(KEYS_AWAY_REASON);
    expect(w.sent).toEqual([]);
  });

  it("does not search an unchanged foreign key set again on the next push", async () => {
    const w = await started({ viewKeys: strangersKeys(), held: false });
    const shown = w.statuses.length;
    let reads = 0;
    const read = w.client.view;
    w.client.view = async () => {
      reads += 1;
      return read();
    };
    w.push(viewOf(strangersKeys(), 2));
    await settle();
    expect(reads).toBe(0);
    expect(w.statuses).toHaveLength(shown);
    expect(w.traderStates).toEqual([]);
  });
});

describe("pressing Move trading here", () => {
  it("installs once, then shows ready, and the seat is confirmed with the new keys", async () => {
    const w = await started({ viewKeys: strangersKeys(), held: false });
    w.sent.length = 0;
    await w.rollup.moveTradingHere(w.wallet);
    await settle();
    expect(w.counts.moves).toBe(1);
    expect(stages(w.statuses).slice(-2)).toEqual(["installing", "ready"]);
    expect(w.sent).toContain("confirmSeat");
    expect(w.traderStates.length).toBeGreaterThan(0);
    expect(w.counts.builds).toBe(1);
  });

  it("goes back to elsewhere, with no failure, when the wallet declines", async () => {
    const w = await started({
      viewKeys: strangersKeys(),
      held: false,
      moveKeysHere: async () => {
        throw new Error("User rejected the request");
      },
    });
    await w.rollup.moveTradingHere(w.wallet);
    await settle();
    expect(stages(w.statuses).slice(-2)).toEqual(["installing", "elsewhere"]);
    expect(stages(w.statuses)).not.toContain("failed");
    expect(w.sent).not.toContain("confirmSeat");
  });

  it("settles an ambiguous error by the view: ready when the view holds the new keys", async () => {
    const w = await started({
      viewKeys: strangersKeys(),
      held: false,
      moveKeysHere: async (install) => {
        install();
        throw new Error("the rollup stopped answering");
      },
    });
    await w.rollup.moveTradingHere(w.wallet);
    await settle();
    expect(stages(w.statuses).at(-1)).toBe("ready");
    expect(stages(w.statuses)).not.toContain("failed");
  });

  it("settles an ambiguous error by the view: failed when the view does not hold them", async () => {
    const w = await started({
      viewKeys: strangersKeys(),
      held: false,
      moveKeysHere: async () => {
        throw new Error("the rollup stopped answering");
      },
    });
    await w.rollup.moveTradingHere(w.wallet);
    await settle();
    expect(w.statuses.at(-1)).toMatchObject({ stage: "failed" });
    await expectEveryKeyPathRefused(w);
  });

  it("does not install when the stops it would cancel were not what the trader was warned about", async () => {
    const w = await started({ viewKeys: strangersKeys(), held: false, seatRecorded: false });
    expect(w.statuses.at(-1)).toEqual(expect.objectContaining({ stage: "elsewhere" }));
    expect(w.statuses.at(-1)).toMatchObject({ cancelsStops: false });
    w.setView(viewOf(strangersKeys(), 2, true));
    await w.rollup.moveTradingHere(w.wallet);
    await settle();
    expect(w.counts.moves).toBe(0);
    expect(w.statuses.at(-1)).toMatchObject({ stage: "elsewhere", cancelsStops: true });
    await w.rollup.moveTradingHere(w.wallet);
    await settle();
    expect(w.counts.moves).toBe(1);
    expect(stages(w.statuses).at(-1)).toBe("ready");
  });

  it("waits for a build that is still running, and two presses in a row install once", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const w = world({ viewKeys: strangersKeys(), held: false, gate, seatRecorded: false });
    const presses = Promise.all([
      w.rollup.moveTradingHere(w.wallet),
      w.rollup.moveTradingHere(w.wallet),
    ]);
    await settle();
    expect(w.counts.moves).toBe(0);
    release();
    await presses;
    await settle();
    expect(w.counts.builds).toBe(1);
    expect(w.counts.moves).toBe(1);
    expect(stages(w.statuses).at(-1)).toBe("ready");
  });

  it("does nothing on a session that is not away", async () => {
    const w = await started({ viewKeys: ownKeys(), held: true });
    await w.rollup.moveTradingHere(w.wallet);
    expect(w.counts.moves).toBe(0);
  });
});

describe("a session that held trading and gets a foreign view", () => {
  it("is not moved by a push that the fresh read contradicts", async () => {
    const w = await started({ viewKeys: ownKeys(), held: true });
    w.push(viewOf(strangersKeys(), 2));
    await settle();
    expect(stages(w.statuses)).not.toContain("moved");
    await expect(w.rollup.cancelOrder(w.wallet, "NSOL-PERP", "7")).rejects.toThrow("sent");
  });

  it("is moved when the fresh read confirms the foreign keys, and then refuses every key path", async () => {
    const w = await started({ viewKeys: ownKeys(), held: true });
    const shown = w.traderStates.length;
    w.setView(viewOf(strangersKeys(), 2));
    w.push(viewOf(strangersKeys(), 2));
    await settle();
    expect(w.statuses.at(-1)).toMatchObject({ stage: "moved", cancelsStops: true });
    expect(w.traderStates).toHaveLength(shown);
    w.sent.length = 0;
    await expectEveryKeyPathRefused(w);
    expect(w.sent).toEqual([]);
  });

  it("is not moved by another tab of this browser: the keys are brought in step instead", async () => {
    const w = await started({ viewKeys: ownKeys(), held: true });
    w.setView(viewOf(sameSeedOtherTab(), 2));
    w.push(viewOf(sameSeedOtherTab(), 2));
    await settle();
    expect(stages(w.statuses)).not.toContain("moved");
    expect(w.counts.resyncs).toBe(1);
    await expect(w.rollup.cancelOrder(w.wallet, "NSOL-PERP", "7")).rejects.toThrow("sent");
  });

  it("is found out by a NotOrderKey refusal whose fresh view shows foreign keys, with no retry", async () => {
    const w = world({ viewKeys: ownKeys(), held: true });
    let sends = 0;
    w.client.placeOrder = (async () => {
      sends += 1;
      throw programRefusal(PROGRAM_ERROR.notOrderKey);
    }) as never;
    w.start();
    await settle();
    w.setView(viewOf(strangersKeys(), 2));
    const placed = await w.rollup.placeOrder(w.wallet, ORDER as never);
    expect(sends).toBe(1);
    expect(placed.reason).toBe(KEYS_AWAY_REASON);
    expect(stages(w.statuses).at(-1)).toBe("moved");
  });

  it("keeps a session that never held as elsewhere, not moved", async () => {
    const w = await started({ viewKeys: strangersKeys(), held: false });
    w.setView(viewOf(keysOf(STRANGER_SEED, [4, 5, 6, 7]), 2));
    w.push(viewOf(keysOf(STRANGER_SEED, [4, 5, 6, 7]), 2));
    await settle();
    expect(stages(w.statuses)).not.toContain("moved");
    expect(stages(w.statuses).at(-1)).toBe("elsewhere");
  });
});

describe("a session that is never away", () => {
  it("is not away on a fake that omits the away-aware methods, whatever the view holds", async () => {
    const w = await started({ viewKeys: strangersKeys(), held: true, awareSession: false });
    expect(stages(w.statuses)).not.toContain("elsewhere");
    expect(stages(w.statuses)).not.toContain("moved");
    await expect(w.rollup.cancelOrder(w.wallet, "NSOL-PERP", "7")).rejects.toThrow("sent");
  });

  it("is not away when the account is not opened, and opening the account flow does not wait", async () => {
    const w = await started({ viewKeys: ownKeys(), held: true, noView: true });
    expect(stages(w.statuses)).toEqual(["ready"]);
    expect(await w.rollup.accountStatus(w.wallet)).toBe("absent");
    expect(w.traderStates).toHaveLength(1);
    expect(w.counts.builds).toBe(1);
  });
});

describe("holdsKeysOf", () => {
  const keys = freshOrderKeys(SEED);

  it("holds a view that carries one of its live keys", () => {
    expect(
      holdsKeysOf(keys, { orderKeys: [...strangersKeys().slice(0, 3), keys.publicKeys[2]] }),
    ).toBe(true);
  });

  it("holds a view that carries a replacement it handed out and has not seen confirmed", () => {
    const handedOut = freshOrderKeys(SEED);
    const uses = [0, 1, 2, 3].map(() => handedOut.take());
    const view = { orderKeys: uses.map((use) => use.replacement.publicKey) };
    expect(holdsKeysOf(handedOut, view)).toBe(true);
  });

  it("does not hold a view of keys from another seed", () => {
    expect(holdsKeysOf(keys, { orderKeys: strangersKeys() })).toBe(false);
  });
});
