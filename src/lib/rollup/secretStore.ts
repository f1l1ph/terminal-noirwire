import { bytesToHex, hexToBytes, ownerDataKeys, type KeyValueStore } from "../wallet/index";

export type TrackedTriggerKind = "takeProfit" | "stopLoss";

export interface TrackedOrderSecret {
  market: string;
  secretHex: string;
  placedAtMs: number;
  /** A trigger's secret: kept past the cap, because the trigger has no expiry and can fire much later. */
  pinned?: true;
  /** Which trigger the pinned secret belongs to. */
  trigger?: TrackedTriggerKind;
}

/** Bounds the store so it cannot grow without end; evicts oldest first (see BUILD-NOTES.md). */
const MAX_TRACKED = 20;
/** Room that order secrets always keep, however many triggers are pinned. */
const MIN_UNPINNED = 5;

const keyFor = ownerDataKeys.orderSecrets;

/**
 * Every order secret this session has placed for `ownerAddress`, so a reload
 * still recognises that order's fills on the public tape (DESIGN.md section
 * 3 is about the trader's own view; this is the browser-side half, for the
 * receipt-based "yours" recognition in `ownFills.ts`). Capped at the most
 * recent `MAX_TRACKED` rather than tracking each order's exact open/closed
 * lifecycle, which this terminal's session-only fill history does not need.
 * A pinned secret (a trigger's) is never evicted by the cap.
 */
export function loadTrackedSecrets(
  storage: KeyValueStore,
  ownerAddress: string,
): TrackedOrderSecret[] {
  const raw = storage.getItem(keyFor(ownerAddress));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as TrackedOrderSecret[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry) =>
        typeof entry?.market === "string" &&
        typeof entry?.secretHex === "string" &&
        typeof entry?.placedAtMs === "number",
    );
  } catch {
    return [];
  }
}

/** The oldest unpinned entries go first; a pinned one stays whatever the count. */
export function evictOldest(entries: TrackedOrderSecret[]): TrackedOrderSecret[] {
  const pinned = entries.filter((entry) => entry.pinned).length;
  const keepUnpinned = Math.max(MAX_TRACKED - pinned, MIN_UNPINNED);
  let toDrop = entries.length - pinned - keepUnpinned;
  if (toDrop <= 0) return entries;
  return entries.filter((entry) => {
    if (entry.pinned || toDrop <= 0) return true;
    toDrop -= 1;
    return false;
  });
}

export function trackSecret(
  storage: KeyValueStore,
  ownerAddress: string,
  market: string,
  secret: Uint8Array,
  trigger?: TrackedTriggerKind,
): TrackedOrderSecret[] {
  const existing = loadTrackedSecrets(storage, ownerAddress);
  const entry: TrackedOrderSecret = {
    market,
    secretHex: bytesToHex(secret),
    placedAtMs: Date.now(),
    ...(trigger ? { pinned: true as const, trigger } : {}),
  };
  const next = evictOldest([...existing, entry]);
  storage.setItem(keyFor(ownerAddress), JSON.stringify(next));
  return next;
}

/** Forgets a secret whose order was never sent, so it does not take the place of one that was. */
export function untrackSecret(
  storage: KeyValueStore,
  ownerAddress: string,
  secret: Uint8Array,
): void {
  const secretHex = bytesToHex(secret);
  const existing = loadTrackedSecrets(storage, ownerAddress);
  const next = existing.filter((entry) => entry.secretHex !== secretHex);
  if (next.length !== existing.length) storage.setItem(keyFor(ownerAddress), JSON.stringify(next));
}

/**
 * Releases the pin of a trigger's secrets: the trigger is gone, cancelled or
 * replaced, so its secret ages out like an order's. `except` is the secret of
 * the trigger that replaced it.
 */
export function unpinTriggerSecrets(
  storage: KeyValueStore,
  ownerAddress: string,
  market: string,
  trigger: TrackedTriggerKind,
  except?: Uint8Array,
): void {
  const keep = except ? bytesToHex(except) : null;
  const existing = loadTrackedSecrets(storage, ownerAddress);
  let changed = false;
  const next = existing.map((entry): TrackedOrderSecret => {
    if (!entry.pinned || entry.market !== market || entry.trigger !== trigger) return entry;
    if (entry.secretHex === keep) return entry;
    changed = true;
    return { market: entry.market, secretHex: entry.secretHex, placedAtMs: entry.placedAtMs };
  });
  if (changed) storage.setItem(keyFor(ownerAddress), JSON.stringify(evictOldest(next)));
}

export function trackedSecretBytes(entries: TrackedOrderSecret[]): Uint8Array[] {
  return entries.map((entry) => hexToBytes(entry.secretHex));
}
