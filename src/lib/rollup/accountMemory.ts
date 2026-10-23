import { ownerDataKeys, type KeyValueStore } from "../wallet/index";

/**
 * An order that may have reached the venue with no result to prove it.
 * `tag` is the order's fill identifier (the one `secretStore` already keeps
 * so its fills are recognised); no key material is stored here.
 */
export interface UnknownHold {
  market: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  size: string;
  price: string;
  tag: string;
  sentAtMs: number;
  /** When the order itself stops being able to rest, if it carries an expiry. */
  orderExpiresAtMs: number | null;
}

/** With no expiry of its own, a held order cannot be cleared by hand until this long after it was sent. */
export const UNKNOWN_HOLD_CLEAR_AFTER_MS = 120_000;

/** The instant from which the trader may clear a hold by hand: after the order's expiry if it has one, else a fixed wait after the send. */
export function holdClearableAtMs(
  hold: Pick<UnknownHold, "sentAtMs" | "orderExpiresAtMs">,
): number {
  return hold.orderExpiresAtMs ?? hold.sentAtMs + UNKNOWN_HOLD_CLEAR_AFTER_MS;
}

const holdsKey = ownerDataKeys.unknownHolds;
const openedKey = ownerDataKeys.accountOpened;

function isHold(value: unknown): value is UnknownHold {
  const hold = value as UnknownHold | null;
  return (
    !!hold &&
    typeof hold.market === "string" &&
    (hold.side === "buy" || hold.side === "sell") &&
    (hold.type === "market" || hold.type === "limit") &&
    typeof hold.size === "string" &&
    typeof hold.price === "string" &&
    typeof hold.tag === "string" &&
    typeof hold.sentAtMs === "number" &&
    (hold.orderExpiresAtMs === null || typeof hold.orderExpiresAtMs === "number")
  );
}

/** Every storage access is best effort: a store that throws is read as empty and written as nothing. */
export function loadHolds(storage: KeyValueStore, address: string): Record<string, UnknownHold> {
  try {
    const raw = storage.getItem(holdsKey(address));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const holds: Record<string, UnknownHold> = {};
    for (const [market, value] of Object.entries(parsed)) {
      if (isHold(value)) holds[market] = value;
    }
    return holds;
  } catch {
    return {};
  }
}

function writeHolds(
  storage: KeyValueStore,
  address: string,
  holds: Record<string, UnknownHold>,
): boolean {
  try {
    if (Object.keys(holds).length === 0) storage.removeItem(holdsKey(address));
    else storage.setItem(holdsKey(address), JSON.stringify(holds));
    return true;
  } catch {
    return false;
  }
}

/** Whether the hold was written: a caller about to send an order must not go ahead without it. */
export function saveHold(storage: KeyValueStore, address: string, hold: UnknownHold): boolean {
  return writeHolds(storage, address, { ...loadHolds(storage, address), [hold.market]: hold });
}

export function removeHold(storage: KeyValueStore, address: string, market: string): void {
  const holds = loadHolds(storage, address);
  if (!(market in holds)) return;
  delete holds[market];
  writeHolds(storage, address, holds);
}

/** Set once this wallet's account has been read successfully or opened: from then on an unreadable view is never taken as an empty account. */
export function markAccountOpened(storage: KeyValueStore, address: string): void {
  try {
    storage.setItem(openedKey(address), "1");
  } catch {
    // Best effort.
  }
}

export function wasAccountOpened(storage: KeyValueStore, address: string): boolean {
  try {
    return storage.getItem(openedKey(address)) === "1";
  } catch {
    return false;
  }
}
