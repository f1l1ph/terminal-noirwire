import type { FailureReason } from "../analytics";
import { failureReasonOf } from "../failureReason";
import { isWalletDecline } from "../wallet/declined";
import { OwnerActionFailed, OwnerActionRefused } from "./ownerMessages";
import {
  freshOrderKeys,
  isKeysNotFromSeed,
  orderKeysFromCheckpoint,
  orderKeysFromIndex,
  type OrderKeyCheckpoint,
  type OrderKeyManager,
  type View,
} from "./sdk";

/**
 * How far the first, quick searches look. The full search (100,000 indices)
 * takes many seconds when the keys are not there, so it runs only once the
 * quick ones have ruled out the common cases: this seed's keys not far in,
 * or keys left from the earlier seed derivation.
 */
export const QUICK_KEY_SEARCH = 1_024;

/** Where the order keys stand while a session is built, for the UI to show. */
export type OrderKeyStatus =
  /** The view holds keys this device did not make; nothing changes until the owner presses Move trading here. */
  | { stage: "elsewhere"; cancelsStops: boolean }
  /** Another device took over while this session was live. */
  | { stage: "moved"; cancelsStops: boolean }
  /** The owner pressed Move trading here: the wallet is asked, then the view is checked. */
  | { stage: "installing" }
  | { stage: "ready" }
  /** Setting up the keys did not finish; `reason` is plain text for the trader. Building the session again retries. */
  | { stage: "failed"; reason: string; failure?: FailureReason };

/** A plain, token-free reason for a failed key setup. */
function keySetupFailureReason(error: unknown): string {
  if (error instanceof OwnerActionFailed || error instanceof OwnerActionRefused) {
    return error.message;
  }
  if (isWalletDecline(error)) {
    return "The wallet request was declined.";
  }
  return "Trading keys could not be set up on this device.";
}

/** The per-device seed store the keys come from; `orderSeedStore` is the real one. */
export interface DeviceSeeds {
  load(owner: string): Promise<Uint8Array | null>;
  create(owner: string): Promise<Uint8Array>;
}

/**
 * Whether replacing the keys may cancel stop loss and take profit orders:
 * the view records a seat. Replacing the keys raises the live seat epoch
 * whatever the snapshot shows, and the snapshot can predate a fill or a
 * trigger change, so a recorded seat is enough to warn.
 */
export function cancelsStops(view: View): boolean {
  return view.seatRecorded;
}

export interface DeviceKeyDeps {
  ownerAddress: string;
  seeds: DeviceSeeds;
  checkpoint: OrderKeyCheckpoint | null;
  /** The owner's view, or null while the account is not opened. Any other failure throws. */
  readView(keys: OrderKeyManager): Promise<View | null>;
  report(status: OrderKeyStatus): void;
}

/** The session's keys, and whether they are the ones the account holds (`held`) or a set that only a move can install. */
export interface DeviceOrderKeys {
  keys: OrderKeyManager;
  held: boolean;
}

/**
 * The account's order keys, drawn from this device's random seed (never from
 * the owner secret). Not opened yet: the first four keys, which `open_trader`
 * installs. Opened, and the view holds keys this seed made: those. Opened
 * with keys this device cannot make (a new device, cleared storage, another
 * device took over): report `elsewhere` and hand back a set that is not held,
 * starting past this device's saved checkpoint (the first four keys when it
 * has none). Nothing is installed and nothing waits here; the owner's press
 * of Move trading here installs later, on the session this returns. There is
 * no wait before that install: the program checks every order-key
 * instruction against the view's current keys when it executes, so an
 * instruction signed by a replaced key is refused with `NotOrderKey` and
 * either ran before the replacement or never runs. A seed that cannot be
 * stored refuses to trade rather than use one that would be lost on reload.
 */
export async function deviceOrderKeys(deps: DeviceKeyDeps): Promise<DeviceOrderKeys> {
  try {
    return await setUpDeviceOrderKeys(deps);
  } catch (error) {
    deps.report({
      stage: "failed",
      reason: keySetupFailureReason(error),
      failure: failureReasonOf(error),
    });
    throw error;
  }
}

export class SeedStorageError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "the order seed store failed", { cause });
    this.name = "SeedStorageError";
  }
}

async function deviceSeed(
  deps: DeviceKeyDeps,
): Promise<{ existing: Uint8Array | null; seed: Uint8Array }> {
  try {
    const existing = await deps.seeds.load(deps.ownerAddress);
    return { existing, seed: existing ?? (await deps.seeds.create(deps.ownerAddress)) };
  } catch (error) {
    throw new SeedStorageError(error);
  }
}

async function setUpDeviceOrderKeys(deps: DeviceKeyDeps): Promise<DeviceOrderKeys> {
  const { existing, seed } = await deviceSeed(deps);
  const fresh = freshOrderKeys(seed);
  const view = await deps.readView(fresh);
  if (!view) return { keys: fresh, held: true };

  if (existing) {
    try {
      return {
        keys: orderKeysFromCheckpoint(seed, view, deps.checkpoint, QUICK_KEY_SEARCH),
        held: true,
      };
    } catch (error) {
      if (!isKeysNotFromSeed(error)) throw error;
    }
    // The full search (100,000 indices) takes many seconds, so it runs only
    // for a device that has used these keys before and so left a checkpoint.
    if (deps.checkpoint) {
      try {
        return { keys: orderKeysFromCheckpoint(seed, view, null), held: true };
      } catch (error) {
        if (!isKeysNotFromSeed(error)) throw error;
      }
    }
  }

  deps.report({ stage: "elsewhere", cancelsStops: cancelsStops(view) });
  return { keys: keysWhenNotHeld(seed, deps.checkpoint), held: false };
}

/**
 * The keys of a session that does not hold the account's: never behind this
 * device's high-water mark. A device that traded before has handed out keys
 * up to its saved checkpoint, so its manager starts there; a move installs
 * the manager's next four keys, which must lie where the manager's
 * `resync` can find them (it looks only a few indices past `nextIndex`). A
 * device with no history starts from the first four keys.
 */
export function keysWhenNotHeld(
  seed: Uint8Array,
  checkpoint: OrderKeyCheckpoint | null,
): OrderKeyManager {
  return checkpoint ? orderKeysFromIndex(seed, checkpoint.nextIndex) : freshOrderKeys(seed);
}

export interface MoveKeysDeps {
  /** The session's manager; the new keys start at its own `nextIndex`. */
  keys: OrderKeyManager;
  /** Installs the given keys with one owner signature. */
  install(replacement: OrderKeyManager): Promise<void>;
  /** The owner's view as it stands after the install. */
  readView(): Promise<View>;
}

/**
 * Installs four keys at indices this device never handed out (from the
 * manager's own `nextIndex`, which sits at or past everything this device
 * signed with), then brings the manager in step with the view. The installed
 * keys never include one handed out before, so an instruction signed earlier
 * can never come back to life, and `resync` always reaches them.
 *
 * A slot lent out when the move lands is left to its own call, which is
 * correct either way: settled with a view, the slot finds the new key it
 * shows (the search reaches it, since `nextIndex` only grows); released
 * without one (the instruction did not run) it keeps the replaced key, and
 * the next call signed with it is refused as NotOrderKey, which `resync`
 * heals before the one retry.
 */
export async function moveOrderKeysHere(deps: MoveKeysDeps): Promise<void> {
  const { keys } = deps;
  await deps.install(orderKeysFromIndex(keys.seed, keys.checkpoint.nextIndex));
  keys.resync(await deps.readView());
}

/**
 * Whether every key `view` holds derives from `seed`, searched near each
 * checkpoint given: this session's own, and the one saved in storage, which
 * another tab of this browser keeps close to the keys in use.
 */
export function viewDerivesFromSeed(
  seed: Uint8Array,
  view: Pick<View, "orderKeys">,
  checkpoints: readonly (OrderKeyCheckpoint | null)[],
): boolean {
  for (const checkpoint of checkpoints) {
    if (!checkpoint) continue;
    try {
      orderKeysFromCheckpoint(seed, view, checkpoint, QUICK_KEY_SEARCH);
      return true;
    } catch (error) {
      if (!isKeysNotFromSeed(error)) throw error;
    }
  }
  return false;
}
