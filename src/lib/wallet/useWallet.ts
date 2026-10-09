"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  browserLocalStorage,
  clearWallet,
  createWallet,
  exportSecret,
  importWallet,
  loadWallet,
  type WalletAccount,
} from "./index";

export interface WalletHookResult {
  account: WalletAccount | null;
  /** True once the client has checked localStorage; false during server render and the first paint. */
  ready: boolean;
  create(): WalletAccount;
  importSecret(secretHex: string): WalletAccount;
  exportCurrent(): string | null;
  reset(): void;
}

/**
 * The wallet lives in localStorage, which React doesn't know about, so it's
 * read through a tiny external store rather than loaded in an effect:
 * `useSyncExternalStore` gives every component the same answer, agrees with
 * the server (null) until hydration, and needs no setState call to react to
 * this tab's own writes.
 */
let cachedAccount: WalletAccount | null | undefined;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): WalletAccount | null {
  if (cachedAccount === undefined) {
    cachedAccount = loadWallet(browserLocalStorage());
  }
  return cachedAccount;
}

function getServerSnapshot(): WalletAccount | null {
  return null;
}

export function useWallet(): WalletHookResult {
  const account = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const ready = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );

  const create = useCallback((): WalletAccount => {
    const next = createWallet(browserLocalStorage());
    cachedAccount = next;
    notify();
    return next;
  }, []);

  const importSecret = useCallback((secretHex: string): WalletAccount => {
    const next = importWallet(browserLocalStorage(), secretHex);
    cachedAccount = next;
    notify();
    return next;
  }, []);

  const exportCurrent = useCallback((): string | null => exportSecret(browserLocalStorage()), []);

  const reset = useCallback((): void => {
    clearWallet(browserLocalStorage());
    cachedAccount = null;
    notify();
  }, []);

  return { account, ready, create, importSecret, exportCurrent, reset };
}
