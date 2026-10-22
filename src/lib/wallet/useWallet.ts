"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  browserLocalStorage,
  clearWallet,
  createWallet,
  importWallet,
  loadLegacyWallet,
  lockedWalletAddress,
  protectWallet,
  unlockWallet,
  type WalletAccount,
} from "./index";

export interface WalletHookResult {
  /** The unlocked wallet, held in memory only. */
  account: WalletAccount | null;
  /** True once the client has checked localStorage; false during server render and the first paint. */
  ready: boolean;
  /** The address of an encrypted wallet on this device that is not unlocked yet. */
  lockedAddress: string | null;
  /** Whether `account` is kept on this device, encrypted. False means a reload loses it. */
  saved: boolean;
  create(): WalletAccount;
  /** Resolves false for a wrong passphrase. */
  unlock(passphrase: string): Promise<boolean>;
  /** Encrypts the current wallet under `passphrase` and keeps it on this device. */
  protect(passphrase: string): Promise<void>;
  /** Throws `WalletExistsError` when a different wallet is kept here and `replace` is not set. */
  importSecret(secretHex: string, options?: { replace?: boolean }): WalletAccount;
  exportCurrent(): string | null;
  reset(): void;
}

interface WalletSnapshot {
  account: WalletAccount | null;
  lockedAddress: string | null;
  saved: boolean;
}

/**
 * The wallet's secret lives in memory once unlocked, and encrypted in
 * localStorage once protected; React knows about neither, so both are read
 * through a tiny external store rather than loaded in an effect:
 * `useSyncExternalStore` gives every component the same answer, agrees with
 * the server (nothing) until hydration, and needs no setState call to react
 * to this tab's own changes. A wallet left in plain text by an earlier build
 * is loaded unlocked and unsaved, so the trader is asked to protect it.
 */
let snapshot: WalletSnapshot | undefined;
const SERVER_SNAPSHOT: WalletSnapshot = { account: null, lockedAddress: null, saved: false };
const listeners = new Set<() => void>();

function setSnapshot(next: WalletSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): WalletSnapshot {
  if (snapshot === undefined) {
    const storage = browserLocalStorage();
    const lockedAddress = lockedWalletAddress(storage);
    snapshot = lockedAddress
      ? { account: null, lockedAddress, saved: true }
      : { account: loadLegacyWallet(storage), lockedAddress: null, saved: false };
  }
  return snapshot;
}

function getServerSnapshot(): WalletSnapshot {
  return SERVER_SNAPSHOT;
}

export function useWallet(): WalletHookResult {
  const { account, lockedAddress, saved } = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  const ready = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );

  const create = useCallback((): WalletAccount => {
    const next = createWallet(browserLocalStorage());
    setSnapshot({ account: next, lockedAddress: null, saved: false });
    return next;
  }, []);

  const unlock = useCallback(async (passphrase: string): Promise<boolean> => {
    const unlocked = await unlockWallet(browserLocalStorage(), passphrase);
    if (!unlocked) return false;
    setSnapshot({ account: unlocked, lockedAddress: null, saved: true });
    return true;
  }, []);

  const protect = useCallback(async (passphrase: string): Promise<void> => {
    const current = getSnapshot().account;
    if (!current) throw new Error("There is no wallet to protect");
    await protectWallet(browserLocalStorage(), current, passphrase);
    setSnapshot({ account: current, lockedAddress: null, saved: true });
  }, []);

  const importSecret = useCallback(
    (secretHex: string, options?: { replace?: boolean }): WalletAccount => {
      const storage = browserLocalStorage();
      const next = importWallet(storage, secretHex, {
        ...options,
        heldAddress: getSnapshot().account?.publicKey,
      });
      const saved = lockedWalletAddress(storage) === next.publicKey;
      setSnapshot({ account: next, lockedAddress: null, saved });
      return next;
    },
    [],
  );

  const exportCurrent = useCallback((): string | null => account?.secretKeyHex ?? null, [account]);

  const reset = useCallback((): void => {
    clearWallet(browserLocalStorage());
    setSnapshot({ account: null, lockedAddress: null, saved: false });
  }, []);

  return {
    account,
    ready,
    lockedAddress,
    saved,
    create,
    unlock,
    protect,
    importSecret,
    exportCurrent,
    reset,
  };
}
