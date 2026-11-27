import { ownerDataKeys, type KeyValueStore } from "../wallet/index";
import type { TriggerKind, TriggerStatuses } from "./types";

/** What this device remembers about a trigger it set: the exchange keeps the price sealed, so this is the only copy a trader can see. */
export interface LocalTrigger {
  price: string;
  /** Null: the whole position at the time it fires. */
  size: string | null;
  slippageBps: number;
  /** The direction of the position it was set on, so a record never outlives a flip to the other side. */
  long: boolean;
  setAtMs: number;
}

export type LocalTriggers = Partial<Record<TriggerKind, LocalTrigger>>;
export type LocalTriggerBook = Record<string, LocalTriggers>;

const KINDS: readonly TriggerKind[] = ["takeProfit", "stopLoss"];

function isLocalTrigger(value: unknown): value is LocalTrigger {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.price === "string" &&
    (entry.size === null || typeof entry.size === "string") &&
    typeof entry.slippageBps === "number" &&
    typeof entry.long === "boolean" &&
    typeof entry.setAtMs === "number"
  );
}

export function loadTriggerBook(storage: KeyValueStore, owner: string): LocalTriggerBook {
  let parsed: unknown;
  try {
    const raw = storage.getItem(ownerDataKeys.triggerPrices(owner));
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const book: LocalTriggerBook = {};
  for (const [market, entry] of Object.entries(parsed)) {
    if (typeof entry !== "object" || entry === null) continue;
    const kept: LocalTriggers = {};
    for (const kind of KINDS) {
      const candidate = (entry as Record<string, unknown>)[kind];
      if (isLocalTrigger(candidate)) kept[kind] = candidate;
    }
    if (Object.keys(kept).length > 0) book[market] = kept;
  }
  return book;
}

function saveTriggerBook(storage: KeyValueStore, owner: string, book: LocalTriggerBook): void {
  try {
    if (Object.keys(book).length === 0) storage.removeItem(ownerDataKeys.triggerPrices(owner));
    else storage.setItem(ownerDataKeys.triggerPrices(owner), JSON.stringify(book));
  } catch {
    // Without storage the price is simply not shown here; the exchange still holds the trigger.
  }
}

export function setLocalTrigger(
  storage: KeyValueStore,
  owner: string,
  market: string,
  kind: TriggerKind,
  trigger: LocalTrigger,
): LocalTriggerBook {
  const book = loadTriggerBook(storage, owner);
  book[market] = { ...book[market], [kind]: trigger };
  saveTriggerBook(storage, owner, book);
  return book;
}

export function clearLocalTrigger(
  storage: KeyValueStore,
  owner: string,
  market: string,
  kind: TriggerKind,
): LocalTriggerBook {
  const book = loadTriggerBook(storage, owner);
  const rest: LocalTriggers = { ...book[market] };
  delete rest[kind];
  if (Object.keys(rest).length === 0) delete book[market];
  else book[market] = rest;
  saveTriggerBook(storage, owner, book);
  return book;
}

/**
 * The records the exchange has since contradicted. A trigger reported gone,
 * by a read taken after it was set, is no longer there whatever this device
 * remembers; one set on the other side of the position never belonged to it.
 */
export function staleTriggerKinds(
  local: LocalTriggers,
  statuses: TriggerStatuses | null,
  long: boolean,
): TriggerKind[] {
  return KINDS.filter((kind) => {
    const record = local[kind];
    if (!record) return false;
    if (record.long !== long) return true;
    return (
      statuses !== null &&
      !statuses.stale &&
      statuses[kind].state === "gone" &&
      statuses.readAtMs > record.setAtMs
    );
  });
}

/**
 * The records still standing: those of markets that still hold a position,
 * minus any the exchange has since contradicted (`staleTriggerKinds`). The
 * rest of the book is what to forget.
 */
export function splitTriggerBook(
  book: LocalTriggerBook,
  positions: Record<string, { size: string }>,
  statuses: Record<string, TriggerStatuses>,
): { standing: LocalTriggerBook; forgotten: { market: string; kinds: TriggerKind[] }[] } {
  const standing: LocalTriggerBook = {};
  const forgotten: { market: string; kinds: TriggerKind[] }[] = [];
  for (const [market, local] of Object.entries(book)) {
    const position = positions[market];
    if (!position || Number(position.size) === 0) {
      forgotten.push({ market, kinds: KINDS.filter((kind) => local[kind]) });
      continue;
    }
    const stale = staleTriggerKinds(
      local,
      statuses[market] ?? null,
      !position.size.trim().startsWith("-"),
    );
    if (stale.length > 0) forgotten.push({ market, kinds: stale });
    const kept: LocalTriggers = {};
    for (const kind of KINDS) {
      if (local[kind] && !stale.includes(kind)) kept[kind] = local[kind];
    }
    if (Object.keys(kept).length > 0) standing[market] = kept;
  }
  return { standing, forgotten };
}
