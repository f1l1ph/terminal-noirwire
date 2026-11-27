"use client";

import { useEffect, useSyncExternalStore } from "react";
import { track, trackOnce } from "@/lib/analytics";
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

function funModeState(enabled: boolean) {
  return enabled ? "on" : "off";
}

/** Applies a change to the Fun mode settings and counts a switch of Fun mode itself. */
export function changeFunMode(patch: Partial<FunModeSettings>): void {
  const before = store.read();
  if (patch.enabled !== undefined && patch.enabled !== before.enabled) {
    if (patch.enabled) switchedOnCount += 1;
    track("fun_mode_switched", { state: funModeState(patch.enabled) });
  }
  store.write({ ...before, ...patch });
}

/** The Fun mode settings: off until chosen, shared by every component that reads them, remembered in this browser. */
export function useFunMode(): [FunModeSettings, (patch: Partial<FunModeSettings>) => void] {
  const settings = useSyncExternalStore(store.subscribe, store.read, store.serverSnapshot);
  return [settings, changeFunMode];
}

/** Counts, once per page load, whether this browser opened the terminal with Fun mode on or off. */
export function reportFunModeAtLoad(): void {
  trackOnce("fun_mode_seen", "fun_mode_seen", { state: funModeState(store.read().enabled) });
}

export function useReportFunModeAtLoad(): void {
  useEffect(reportFunModeAtLoad, []);
}

/** How many times the trader has switched Fun mode on in this session; a stored "on" at page load does not count. */
export function useFunSwitchedOnCount(): number {
  return useSyncExternalStore(
    store.subscribe,
    () => switchedOnCount,
    () => 0,
  );
}
