import type { KeyValueStore } from "../wallet/index";

/** The statements the trader accepts before the first order from a device. */
export const REAL_MONEY_STATEMENTS = [
  "This is real money on Solana mainnet, and you can lose what you deposit.",
  "Orders are private and final: there is no stop-loss, and NoirWire cannot reverse a trade.",
] as const;

export const acknowledgementKey = (owner: string): string =>
  `noirwire-terminal-real-money-ack:${owner}`;

/** Whether this owner already accepted on this browser; any storage failure reads as not accepted, so the notice is shown again. */
export function hasAcknowledged(storage: KeyValueStore | null, owner: string): boolean {
  if (!storage || !owner) return false;
  try {
    return storage.getItem(acknowledgementKey(owner)) === "1";
  } catch {
    return false;
  }
}

/**
 * Whether this owner must be shown the notice before an order. `acceptedBy` is
 * the owner who accepted during this visit; it counts for that owner only, so
 * switching to another owner asks again.
 */
export function needsAcknowledgement(
  storage: KeyValueStore | null,
  owner: string,
  acceptedBy: string | null,
): boolean {
  if (acceptedBy !== null && acceptedBy === owner) return false;
  return !hasAcknowledged(storage, owner);
}

/** Remembers the acceptance for this owner. False when the browser would not keep it, in which case the notice returns on the next visit. */
export function recordAcknowledgement(storage: KeyValueStore | null, owner: string): boolean {
  if (!storage || !owner) return false;
  try {
    storage.setItem(acknowledgementKey(owner), "1");
    return storage.getItem(acknowledgementKey(owner)) === "1";
  } catch {
    return false;
  }
}
