import type { z } from "zod";
import type { KeyValueStore } from "./wallet/index";

/**
 * The last answer the price service gave for something that rarely changes
 * (its market settings, its deployment description), kept in this browser so
 * a page loaded while the service is down can still show and manage
 * positions. Keyed by service address so environments never mix. Any storage
 * failure reads as "nothing kept", never as an error.
 */
const keyFor = (name: string, simUrl: string): string =>
  `noirwire-terminal-last-known-${name}:${simUrl}`;

/** The kept copy, or null when there is none, storage fails, or the copy no longer fits `schema` (an invalid copy is removed). */
export function loadLastKnown<S extends z.ZodType>(
  storage: KeyValueStore,
  name: string,
  simUrl: string,
  schema: S,
): z.infer<S> | null {
  const key = keyFor(name, simUrl);
  try {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    const parsed = schema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    storage.removeItem(key);
    return null;
  } catch {
    return null;
  }
}

/** Replaces the kept copy with `value`; false when the browser would not keep it. */
export function keepLastKnown(
  storage: KeyValueStore,
  name: string,
  simUrl: string,
  value: unknown,
): boolean {
  try {
    storage.setItem(keyFor(name, simUrl), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
