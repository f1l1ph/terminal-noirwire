"use client";

import { useCallback, useSyncExternalStore } from "react";
import { loadPrivacyTools, savePrivacyTools } from "@/lib/layout/privacyTools";

const listeners = new Set<() => void>();
let current: boolean | null = null;

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function read(): boolean {
  if (current === null) current = loadPrivacyTools(browserStorage());
  return current;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** The privacy-tools switch: off until chosen, shared by every component that reads it, remembered in this browser. */
export function usePrivacyTools(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, read, () => false);
  const set = useCallback((next: boolean) => {
    current = next;
    savePrivacyTools(browserStorage(), next);
    for (const listener of listeners) listener();
  }, []);
  return [on, set];
}
