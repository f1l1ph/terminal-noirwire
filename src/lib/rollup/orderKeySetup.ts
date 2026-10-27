import { OwnerActionFailed, OwnerActionRefused } from "./ownerMessages";
import {
  freshOrderKeys,
  KEYS_NOT_FROM_SEED_MESSAGE,
  orderKeysFromCheckpoint,
  type OrderKeyCheckpoint,
  type OrderKeyManager,
  type View,
} from "./sdk";

/** The program accepts an order-key instruction that expires at most this far ahead. */
const MAX_EXPIRY_AHEAD_MS = 60_000;
/** How far the first, quick search for this seed's keys in the view looks. */
const QUICK_KEY_SEARCH = 1_024;

/** Where the order keys stand while a session is built, for the UI to show. */
export type OrderKeyStatus =
  | { stage: "settling"; readyAtMs: number }
  | { stage: "installing" }
  | { stage: "ready" }
  /** Setting up the keys did not finish; `reason` is plain text for the trader. Building the session again retries. */
  | { stage: "failed"; reason: string };

const REFUSED = /reject|declin|denied|cancel|refus/i;

/** A plain, token-free reason for a failed key setup. */
export function keySetupFailureReason(error: unknown): string {
  if (error instanceof OwnerActionFailed || error instanceof OwnerActionRefused) {
    return error.message;
  }
  if (error instanceof Error && REFUSED.test(`${error.name} ${error.message}`)) {
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
 * How long to wait, from the moment this device decides to replace the
 * account's order keys, so that an instruction signed by the old keys has
 * lapsed. The program caps an instruction's expiry at 60 s. Nothing in the
 * view bounds an instruction in flight (a resting order's good-till time is
 * a different thing), so the wait is always the full cap.
 */
export const SETTLE_WAIT_MS = MAX_EXPIRY_AHEAD_MS;

const isNotFromSeed = (error: unknown) =>
  error instanceof Error && error.message === KEYS_NOT_FROM_SEED_MESSAGE;

export interface DeviceKeyDeps {
  ownerAddress: string;
  seeds: DeviceSeeds;
  checkpoint: OrderKeyCheckpoint | null;
  /** The owner's view, or null while the account is not opened. Any other failure throws. */
  readView(keys: OrderKeyManager): Promise<View | null>;
  /** One owner-signed `set_order_keys`, sent only if the wallet signed exactly what was built. */
  install(keys: OrderKeyManager): Promise<void>;
  report(status: OrderKeyStatus): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/**
 * The account's order keys, drawn from this device's random seed (never from
 * the owner secret). Not opened yet: the first four keys, which `open_trader`
 * installs. Opened, and the view holds keys this seed made: those. Opened
 * with keys this device cannot make (a new device, cleared storage, another
 * device took over): read the view, wait until an order signed by the old
 * keys has lapsed, then install this seed's first four keys with exactly one
 * owner-signed `set_order_keys`. A seed that cannot be stored refuses to
 * trade rather than use one that would be lost on reload.
 */
export async function deviceOrderKeys(deps: DeviceKeyDeps): Promise<OrderKeyManager> {
  try {
    return await setUpDeviceOrderKeys(deps);
  } catch (error) {
    deps.report({ stage: "failed", reason: keySetupFailureReason(error) });
    throw error;
  }
}

async function setUpDeviceOrderKeys(deps: DeviceKeyDeps): Promise<OrderKeyManager> {
  const existing = await deps.seeds.load(deps.ownerAddress);
  const seed = existing ?? (await deps.seeds.create(deps.ownerAddress));
  const fresh = freshOrderKeys(seed);
  const view = await deps.readView(fresh);
  if (!view) return fresh;

  if (existing) {
    try {
      return orderKeysFromCheckpoint(seed, view, deps.checkpoint, QUICK_KEY_SEARCH);
    } catch (error) {
      if (!isNotFromSeed(error)) throw error;
    }
    // The full search (100,000 indices) takes many seconds, so it runs only
    // for a device that has used these keys before and so left a checkpoint.
    if (deps.checkpoint) {
      try {
        return orderKeysFromCheckpoint(seed, view, null);
      } catch (error) {
        if (!isNotFromSeed(error)) throw error;
      }
    }
  }

  deps.report({ stage: "settling", readyAtMs: deps.now() + SETTLE_WAIT_MS });
  await deps.sleep(SETTLE_WAIT_MS);
  deps.report({ stage: "installing" });
  await deps.install(fresh);
  return fresh;
}
