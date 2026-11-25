"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  DEFAULT_FUN_MODE,
  loadFunMode,
  saveFunMode,
  type FunModeSettings,
} from "@/lib/layout/funMode";
import { createPersistedStore } from "@/lib/layout/persistedStore";

const store = createPersistedStore({
  load: loadFunMode,
  save: saveFunMode,
  fallback: DEFAULT_FUN_MODE,
});
let switchedOnCount = 0;

/** The Fun mode settings: off until chosen, shared by every component that reads them, remembered in this browser. */
export function useFunMode(): [FunModeSettings, (patch: Partial<FunModeSettings>) => void] {
  const settings = useSyncExternalStore(store.subscribe, store.read, store.serverSnapshot);
  const update = useCallback((patch: Partial<FunModeSettings>) => {
    const before = store.read();
    if (patch.enabled === true && !before.enabled) switchedOnCount += 1;
    store.write({ ...before, ...patch });
  }, []);
  return [settings, update];
}

/** How many times the trader has switched Fun mode on in this session; a stored "on" at page load does not count. */
export function useFunSwitchedOnCount(): number {
  return useSyncExternalStore(
    store.subscribe,
    () => switchedOnCount,
    () => 0,
  );
}
