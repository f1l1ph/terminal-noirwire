"use client";

import { useSyncExternalStore } from "react";
import { createPersistedStore } from "@/lib/layout/persistedStore";
import { loadPrivacyTools, savePrivacyTools } from "@/lib/layout/privacyTools";

const store = createPersistedStore({
  load: loadPrivacyTools,
  save: savePrivacyTools,
  fallback: false,
});

/** The privacy-tools switch: off until chosen, shared by every component that reads it, remembered in this browser. */
export function usePrivacyTools(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(store.subscribe, store.read, store.serverSnapshot);
  return [on, store.write];
}
