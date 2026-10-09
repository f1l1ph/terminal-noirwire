import { bytesToHex, hexToBytes, type KeyValueStore } from "../wallet/index";

export interface TrackedOrderSecret {
  market: string;
  secretHex: string;
  placedAtMs: number;
}

const KEY_PREFIX = "noirwire-terminal-rollup-secrets-";
/** Bounds the store so it cannot grow without end; evicts oldest first (see BUILD-NOTES.md). */
const MAX_TRACKED = 20;

function keyFor(ownerAddress: string): string {
  return `${KEY_PREFIX}${ownerAddress}`;
}

/**
 * Every order secret this session has placed for `ownerAddress`, so a reload
 * still recognises that order's fills on the public tape (DESIGN.md section
 * 3 is about the trader's own view; this is the browser-side half, for the
 * receipt-based "yours" recognition in `ownFills.ts`). Capped at the most
 * recent `MAX_TRACKED` rather than tracking each order's exact open/closed
 * lifecycle, which this terminal's session-only fill history does not need.
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

export function trackSecret(
  storage: KeyValueStore,
  ownerAddress: string,
  market: string,
  secret: Uint8Array,
): TrackedOrderSecret[] {
  const existing = loadTrackedSecrets(storage, ownerAddress);
  const next = [
    ...existing,
    { market, secretHex: bytesToHex(secret), placedAtMs: Date.now() },
  ].slice(-MAX_TRACKED);
  storage.setItem(keyFor(ownerAddress), JSON.stringify(next));
  return next;
}

export function trackedSecretBytes(entries: TrackedOrderSecret[]): Uint8Array[] {
  return entries.map((entry) => hexToBytes(entry.secretHex));
}
