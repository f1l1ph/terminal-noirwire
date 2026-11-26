import { describe, expect, it } from "vitest";
import { Keypair, type Connection, type PublicKey } from "@solana/web3.js";
import { keypairOwnerSigner } from "@/lib/wallet/ownerSigner";
import { RollupTradingClient } from "@/lib/trading/rollupClient";
import { holdsKeysOf, type RollupSession, type TraderClientLike } from "@/lib/rollup/session";
import {
  keysWhenNotHeld,
  moveOrderKeysHere,
  viewDerivesFromSeed,
  type OrderKeyStatus,
} from "@/lib/rollup/orderKeySetup";
import { loadCheckpoint, saveCheckpoint } from "@/lib/rollup/checkpointStore";
import type { OrderKeyState, WalletIdentity } from "@/lib/trading/types";
import {
  freshOrderKeys,
  KEYS_NOT_FROM_SEED_MESSAGE,
  orderKeysFromCheckpoint,
  orderKeysFromIndex,
  type OrderKeyCheckpoint,
  type OrderKeyManager,
  type View,
} from "@/lib/rollup/sdk";
import { KEYS_AWAY_REASON, KEYS_REBUILD_FAILED_REASON } from "@/lib/rollup/outcome";
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
  tick,
  USDC,
} from "./support/rollupFixtures";

const DEPLOYMENT = singleMarketDeployment();

const range = (first: number) => [first, first + 1, first + 2, first + 3];
const names = (keys: PublicKey[]) => keys.map((key) => key.toBase58());
const checkpointAt = (first: number): OrderKeyCheckpoint => ({
  indices: range(first),
  nextIndex: first + 4,
});

function viewOf(orderKeys: PublicKey[], resultsWritten: number, ownerNonce: number): View {
  return {
    orderKeys,
    resultsWritten,
    ownerNonce,
    results: [],
    seatRecorded: true,
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

describe("moving trading here on a device that traded before", () => {
  const foreign = () => ({ orderKeys: keysOf(STRANGER_SEED, range(0)) });

  const awaySession = async (checkpoint: OrderKeyCheckpoint | null) => ({
    keys: keysWhenNotHeld(SEED, checkpoint),
    held: false,
  });

  it("is the SDK's own limit that makes a manager behind the installed keys unable to resync", () => {
    const behind = freshOrderKeys(SEED);
    expect(() => behind.resync({ orderKeys: keysOf(SEED, range(500)) })).toThrow(
      KEYS_NOT_FROM_SEED_MESSAGE,
    );
  });

  it("installs past everything the device handed out, and the real manager resyncs onto the new keys", async () => {
    const { keys, held } = await awaySession(checkpointAt(96));
    expect(held).toBe(false);
    expect(keys.checkpoint.nextIndex).toBe(104);

    let installed: OrderKeyManager | null = null;
    let viewNow: Pick<View, "orderKeys"> = foreign();
    await moveOrderKeysHere({
      keys,
      install: async (replacement) => {
        installed = replacement;
        viewNow = { orderKeys: replacement.publicKeys };
      },
      readView: async () => viewNow as View,
    });

    expect(names(installed!.publicKeys)).toEqual(names(keysOf(SEED, [104, 105, 106, 107])));
    const handedOutBefore = new Set(names(keysOf(SEED, [0, 1, 2, 3, ...range(96), ...range(100)])));
    expect(names(installed!.publicKeys).some((key) => handedOutBefore.has(key))).toBe(false);
    expect(names(keys.publicKeys)).toEqual(names(installed!.publicKeys));
    expect(holdsKeysOf(keys, viewNow)).toBe(true);
    const use = keys.take();
    expect(names(installed!.publicKeys)).toContain(use.keypair.publicKey.toBase58());
  });

  it("does the same for a session that held, traded, and then saw foreign keys", async () => {
    const keys = freshOrderKeys(SEED);
    for (let call = 0; call < 10; call += 1) keys.confirm(keys.take());
    const next = keys.checkpoint.nextIndex;
    expect(next).toBe(14);

    let viewNow: Pick<View, "orderKeys"> = foreign();
    await moveOrderKeysHere({
      keys,
      install: async (replacement) => {
        viewNow = { orderKeys: replacement.publicKeys };
      },
      readView: async () => viewNow as View,
    });

    expect(names(viewNow.orderKeys)).toEqual(names(keysOf(SEED, [14, 15, 16, 17])));
    expect(holdsKeysOf(keys, viewNow)).toBe(true);
    expect(names(keys.publicKeys)).toEqual(names(viewNow.orderKeys));
  });

  it("leaves a slot that was lent when the move landed to settle onto its new key", async () => {
    const { keys } = await awaySession(checkpointAt(96));
    const lent = keys.take();
    const released = keys.take();
    let viewNow: Pick<View, "orderKeys"> = foreign();
    await moveOrderKeysHere({
      keys,
      install: async (replacement) => {
        viewNow = { orderKeys: replacement.publicKeys };
      },
      readView: async () => viewNow as View,
    });

    expect(keys.settle(lent, viewNow as View)).toBe(true);
    expect(keys.publicKeys[lent.slot].toBase58()).toBe(viewNow.orderKeys[lent.slot].toBase58());

    keys.release(released);
    expect(() => keys.resync(viewNow)).not.toThrow();
    expect(names(keys.publicKeys)).toEqual(names(viewNow.orderKeys));
    expect(keys.take().keypair.publicKey.toBase58()).toBeDefined();
  });
});

describe("recognising this browser's own keys", () => {
  it("finds a view far past the session's own checkpoint through the saved one", () => {
    const view = { orderKeys: keysOf(SEED, range(5000)) };
    expect(viewDerivesFromSeed(SEED, view, [checkpointAt(0)])).toBe(false);
    expect(viewDerivesFromSeed(SEED, view, [checkpointAt(0), checkpointAt(5000)])).toBe(true);
  });

  it("does not recognise another seed's keys", () => {
    const view = { orderKeys: keysOf(STRANGER_SEED, range(0)) };
    expect(viewDerivesFromSeed(SEED, view, [checkpointAt(0), checkpointAt(5000)])).toBe(false);
  });
});

interface WorldOptions {
  /** The manager of the first session starts here (its live keys are `firstIndex` .. +3). */
  firstIndex: number;
  /** The keys the account's view holds at the start. */
  viewKeys: PublicKey[];
  /** The first session was built holding the account's keys. */
  held?: boolean;
  /** The checkpoint saved in this browser's storage at the start. */
  saved?: OrderKeyCheckpoint;
  /** Builds after the first fail. */
  rebuildFails?: boolean;
}

/**
 * A client over fake sessions that carry the REAL key manager: a call signs
 * with a key it takes and is refused as NotOrderKey when the view does not
 * hold it, exactly as the program does.
 */
function world(options: WorldOptions) {
  const owner = keypairOwnerSigner(Keypair.generate());
  const address = owner.publicKey.toBase58();
  const wallet: WalletIdentity = { address };
  const storage = memoryStore();
  if (options.saved) saveCheckpoint(storage, address, options.saved);
  const held = options.held ?? true;
  const statuses: OrderKeyStatus[] = [];
  const traderStates: unknown[] = [];
  const counts = { builds: 0, sends: 0 };
  let viewNow = viewOf(options.viewKeys, 1, 5);
  let push: (view: View) => void = () => {};

  const makeSession = (keys: OrderKeyManager, heldAtBuild: boolean): RollupSession => {
    const client: TraderClientLike = {
      view: async () => viewNow,
      subscribeView: (onChange) => {
        push = onChange;
        return async () => {};
      },
      placeOrder: (async () => {
        throw new Error("unused");
      }) as never,
      cancelOrder: (async () => {
        counts.sends += 1;
        const use = keys.take();
        const inView = viewNow.orderKeys.some((key) => key.equals(use.keypair.publicKey));
        if (!inView) {
          keys.release(use);
          throw programRefusal(PROGRAM_ERROR.notOrderKey);
        }
        const next = [...viewNow.orderKeys];
        next[use.slot] = use.replacement.publicKey;
        viewNow = viewOf(next, viewNow.resultsWritten + 1, viewNow.ownerNonce);
        keys.confirm(use, viewNow);
        return { cancelled: 1n, status: -1, code: 0 };
      }) as never,
      cancelAll: (async () => {
        throw new Error("unused");
      }) as never,
      syncView: (async () => {
        throw new Error("unused");
      }) as never,
      transferBetweenBalances: (async () => {
        throw new Error("unused");
      }) as never,
    };
    return {
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
      saveKeyCheckpoint: () => {
        if (heldAtBuild) saveCheckpoint(storage, address, keys.checkpoint);
      },
      resyncKeys: (view) => keys.resync(view),
      holdsKeysOf: (view) => holdsKeysOf(keys, view),
      keysFromThisSeed: (view) =>
        viewDerivesFromSeed(SEED, view, [keys.checkpoint, loadCheckpoint(storage, address)]),
      heldAtBuild,
      moveKeysHere: () =>
        moveOrderKeysHere({
          keys,
          install: async (replacement) => {
            viewNow = viewOf(replacement.publicKeys, viewNow.resultsWritten + 1, 6);
          },
          readView: async () => viewNow,
        }),
      close: () => {},
    };
  };

  const rollup = new RollupTradingClient({
    simUrl: "http://sim.test",
    marketSettingsLookup: (id) => (id === "NSOL-PERP" ? PERP : undefined),
    storage,
    buildSession: async (_wallet, deps) => {
      counts.builds += 1;
      await tick();
      if (counts.builds === 1) {
        const keys = orderKeysFromIndex(SEED, options.firstIndex);
        deps.onOrderKeys?.(held ? { stage: "ready" } : { stage: "elsewhere", cancelsStops: true });
        return makeSession(keys, held);
      }
      if (options.rebuildFails) throw new Error("the rollup is not answering");
      const keys = orderKeysFromCheckpoint(SEED, viewNow, loadCheckpoint(storage, address));
      deps.onOrderKeys?.({ stage: "ready" });
      return makeSession(keys, true);
    },
  });
  rollup.subscribeOrderKeys(wallet, (state: OrderKeyState) => statuses.push(state));
  return {
    rollup,
    wallet,
    statuses,
    traderStates,
    counts,
    storage,
    start: () => rollup.subscribe(wallet, (state) => traderStates.push(state)),
    push: (view: View) => push(view),
    setView: (view: View) => {
      viewNow = view;
    },
    viewNow: () => viewNow,
  };
}

describe("a second tab of this browser", () => {
  async function started(first: number, ahead: number) {
    const w = world({ firstIndex: first, viewKeys: keysOf(SEED, range(first)) });
    w.start();
    await settle();
    expect(w.traderStates.length).toBeGreaterThan(0);
    saveCheckpoint(w.storage, w.wallet.address, checkpointAt(ahead));
    return w;
  }

  it.each([
    ["far past its own checkpoint", 5000],
    ["only a few indices ahead, where a resync cannot reach", 9],
  ])("shows the view of a tab %s, and is not away", async (_case, ahead) => {
    const w = await started(0, ahead);
    const shown = w.traderStates.length;
    const view = viewOf(keysOf(SEED, range(ahead)), 2, 5);
    w.setView(view);
    w.push(view);
    await settle();
    expect(stages(w.statuses)).not.toContain("moved");
    expect(w.traderStates.length).toBeGreaterThan(shown);
  });

  it("still marks a genuinely foreign view as moved", async () => {
    const w = await started(0, 5000);
    const foreign = viewOf(keysOf(STRANGER_SEED, range(0)), 2, 5);
    w.setView(foreign);
    w.push(foreign);
    await settle();
    expect(stages(w.statuses).at(-1)).toBe("moved");
  });
});

describe("a call after another tab traded", () => {
  async function behindTab(options: { rebuildFails?: boolean } = {}) {
    const w = world({ firstIndex: 0, viewKeys: keysOf(SEED, range(0)), ...options });
    w.start();
    await settle();
    const ahead = viewOf(keysOf(SEED, range(14)), 2, 5);
    w.setView(ahead);
    saveCheckpoint(w.storage, w.wallet.address, checkpointAt(14));
    return w;
  }

  it("rebuilds the session once, retries once, and goes through", async () => {
    const w = await behindTab();
    const result = await w.rollup.cancelOrder(w.wallet, "NSOL-PERP", "7");
    expect(result).toEqual({ cancelled: 1 });
    expect(w.counts.builds).toBe(2);
    expect(w.counts.sends).toBe(2);
  });

  it("shares one rebuild between calls made together", async () => {
    const w = await behindTab();
    const results = await Promise.all([
      w.rollup.cancelOrder(w.wallet, "NSOL-PERP", "7"),
      w.rollup.cancelOrder(w.wallet, "NSOL-PERP", "8"),
    ]);
    expect(results.map((result) => result.cancelled)).toEqual([1, 1]);
    expect(w.counts.builds).toBe(2);
  });

  it("refuses with a plain reason and sends nothing more when the rebuild fails", async () => {
    const w = await behindTab({ rebuildFails: true });
    const result = await w.rollup.cancelOrder(w.wallet, "NSOL-PERP", "7");
    expect(result).toEqual({ cancelled: 0, reason: KEYS_REBUILD_FAILED_REASON });
    expect(w.counts.sends).toBe(1);
    expect(KEYS_REBUILD_FAILED_REASON).not.toBe(KEYS_AWAY_REASON);
  });
});

describe("a read older than the move", () => {
  async function movedHere() {
    const w = world({
      firstIndex: 100,
      viewKeys: keysOf(STRANGER_SEED, range(0)),
      held: false,
      saved: checkpointAt(96),
    });
    w.start();
    await settle();
    await w.rollup.moveTradingHere(w.wallet);
    await settle();
    return w;
  }

  it("does not mark the session away again", async () => {
    const w = await movedHere();
    expect(stages(w.statuses).at(-1)).toBe("ready");
    expect(names(w.viewNow().orderKeys)).toEqual(names(keysOf(SEED, [104, 105, 106, 107])));
    const afterMove = w.statuses.length;
    const movedView = w.viewNow();

    const stale = viewOf(keysOf(STRANGER_SEED, range(0)), 99, 5);
    w.setView(stale);
    w.push(stale);
    await settle();
    expect(w.statuses).toHaveLength(afterMove);

    w.setView(movedView);
    expect(await w.rollup.cancelOrder(w.wallet, "NSOL-PERP", "7")).toEqual({ cancelled: 1 });
  });

  it("still marks the session away for a newer foreign view", async () => {
    const w = await movedHere();
    const newer = viewOf(keysOf(STRANGER_SEED, range(4)), 99, 7);
    w.setView(newer);
    w.push(newer);
    await settle();
    expect(stages(w.statuses).at(-1)).toBe("moved");
  });
});
