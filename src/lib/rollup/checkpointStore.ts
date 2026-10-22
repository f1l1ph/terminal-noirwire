import { ownerDataKeys, type KeyValueStore } from "../wallet/index";
import type { OrderKeyCheckpoint } from "./sdk";

const keyFor = ownerDataKeys.keyCheckpoint;

/**
 * Where the four live order keys sit in the derivation (indices and the
 * next index to derive - no secret, see `OrderKeyCheckpoint`), saved after
 * every confirmed keyed call so a reload recovers them in a handful of
 * derivations instead of `OrderKeyManager.fromView`'s full search.
 */
export function loadCheckpoint(
  storage: KeyValueStore,
  ownerAddress: string,
): OrderKeyCheckpoint | null {
  const raw = storage.getItem(keyFor(ownerAddress));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as OrderKeyCheckpoint;
    if (!Array.isArray(parsed.indices) || typeof parsed.nextIndex !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCheckpoint(
  storage: KeyValueStore,
  ownerAddress: string,
  checkpoint: OrderKeyCheckpoint,
): void {
  storage.setItem(keyFor(ownerAddress), JSON.stringify(checkpoint));
}
