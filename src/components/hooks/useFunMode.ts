"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  DEFAULT_FUN_MODE,
  loadFunMode,
  saveFunMode,
  type FunModeSettings,
} from "@/lib/layout/funMode";

const listeners = new Set<() => void>();
let current: FunModeSettings | null = null;

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function read(): FunModeSettings {
  if (current === null) current = loadFunMode(browserStorage());
  return current;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** The Fun mode settings: off until chosen, shared by every component that reads them, remembered in this browser. */
export function useFunMode(): [FunModeSettings, (patch: Partial<FunModeSettings>) => void] {
  const settings = useSyncExternalStore(subscribe, read, () => DEFAULT_FUN_MODE);
  const update = useCallback((patch: Partial<FunModeSettings>) => {
    current = { ...read(), ...patch };
    saveFunMode(browserStorage(), current);
    for (const listener of listeners) listener();
  }, []);
  return [settings, update];
}
