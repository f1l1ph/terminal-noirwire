import type { KeyValueStore } from "../wallet/index";

/** The statements the trader accepts before the first order from a device. */
export const REAL_MONEY_STATEMENTS = [
  "This is real money on Solana mainnet, and you can lose what you deposit.",
  "Filled trades are final, there is no stop-loss, and only your wallet can withdraw your funds (it needs a little SOL for fees).",
  "Positions can be closed automatically (liquidated) when your margin runs out, with a penalty, and funding is paid or received while a position is open.",
] as const;

/** The version moves up whenever a statement is added, so every trader accepts the new wording once. */
export const acknowledgementKey = (owner: string): string =>
  `noirwire-terminal-real-money-ack:v2:${owner}`;

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
