import type { KeyValueStore } from "@/lib/wallet";

/** What a layout choice needs of browser storage; a storage that throws only means the choice is not remembered. */
export type ChoiceStorage = Pick<KeyValueStore, "getItem" | "setItem">;

export function browserStorage(): ChoiceStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readChoice<T>(
  storage: ChoiceStorage | null,
  key: string,
  parse: (raw: string | null) => T,
  fallback: T,
): T {
  if (!storage) return fallback;
  try {
    return parse(storage.getItem(key));
  } catch {
    return fallback;
  }
}

export function writeChoice(
  storage: ChoiceStorage | null,
  key: string,
  serialize: () => string,
): void {
  if (!storage) return;
  try {
    storage.setItem(key, serialize());
  } catch {
    // The choice holds for this session, just not remembered.
  }
}

/**
 * A module-level store for one remembered choice, shaped for
 * `useSyncExternalStore`: read from storage on first use, shared by every
 * reader, written back and announced on every change. `fallback` is what the
 * server renders.
 */
export function createPersistedStore<T>({
  load,
  save,
  fallback,
}: {
  load: (storage: ChoiceStorage | null) => T;
  save: (storage: ChoiceStorage | null, value: T) => void;
  fallback: T;
}) {
  const listeners = new Set<() => void>();
  let current: { value: T } | null = null;

  function read(): T {
    if (current === null) current = { value: load(browserStorage()) };
    return current.value;
  }

  function subscribe(onChange: () => void): () => void {
    listeners.add(onChange);
    return () => listeners.delete(onChange);
  }

  function write(value: T): void {
    current = { value };
    save(browserStorage(), value);
    for (const listener of listeners) listener();
  }

  return { read, subscribe, write, serverSnapshot: () => fallback };
}
