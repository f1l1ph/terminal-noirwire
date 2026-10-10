"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hexToBytes } from "../wallet/index";
import type { WalletAccount } from "../wallet/index";
import { loadTrackedSecrets } from "../rollup/secretStore";
import { createTradingClient } from "./index";
import type {
  CancelResult,
  FundOutcome,
  MarketSettingsLookup,
  NewOrderInput,
  PlaceOrderResult,
  TraderState,
  TransferResult,
  WalletIdentity,
} from "./types";

const EMPTY_STATE: TraderState = {
  trader: "",
  equity: "0",
  balances: {},
  positions: {},
  openOrders: [],
};

export interface PlacedOrderOutcome {
  result: PlaceOrderResult;
  /** Click-to-acknowledgement, measured on this device with a monotonic clock. */
  clientDurationMs: number;
}

function walletOf(account: WalletAccount): WalletIdentity {
  return { address: account.publicKey, secretKeyHex: account.secretKeyHex };
}

/**
 * Whether this wallet has ever asked for its one-time grant, so a reload
 * never re-offers "Get 5,000 test nUSD" to an account that already used it
 * and has since spent it down to zero (third design review, must-fix 2).
 * Local to this browser: a wallet funded elsewhere first still sees the
 * button once, learns `alreadyFunded`, and is remembered here from then on.
 */
function grantUsedKey(address: string): string {
  return `noirwire-terminal-grant-used:${address}`;
}

function readGrantUsed(address: string | null): boolean {
  if (!address || typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(grantUsedKey(address)) === "1";
  } catch {
    return false;
  }
}

function writeGrantUsed(address: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(grantUsedKey(address), "1");
  } catch {
    // Best effort; worst case the button is offered again next reload.
  }
}

/**
 * One trading session: the selected trading client (dev or rollup), the
 * trader's live state, and this session's own-fill recognition state. Dev
 * mode recognises its own fills by a venue-assigned tag (`ownTags`); rollup
 * mode has no such tag and instead recomputes receipts from this session's
 * own order secrets (`rollupSecrets`, persisted per owner address so a
 * reload still recognises them - see `src/lib/rollup/secretStore.ts`).
 */
export function useTrading(
  wallet: WalletAccount | null,
  marketSettingsLookup: MarketSettingsLookup,
) {
  const client = useMemo(() => createTradingClient(marketSettingsLookup), [marketSettingsLookup]);
  const [state, setState] = useState<TraderState>(EMPTY_STATE);
  // The one piece of truth the footer's sync status reads (item 8 of the
  // second design review): set every time this hook actually writes `state`
  // from the venue, including the initial subscribe on reload, so the
  // footer can never say "not yet synced" beside a dock that already shows
  // a position - the two now read the same event, not two independent ones.
  const [lastSyncedAtMs, setLastSyncedAtMs] = useState<number | null>(null);
  const setStateSynced = useCallback((next: TraderState) => {
    setState(next);
    setLastSyncedAtMs(Date.now());
  }, []);
  const [ownTags, setOwnTags] = useState<ReadonlySet<string>>(new Set());
  const [rollupSecrets, setRollupSecrets] = useState<Uint8Array[]>([]);
  const [grantUsed, setGrantUsed] = useState(false);
  const ownTagsRef = useRef<Set<string>>(new Set());
  const rollupSecretsKeyRef = useRef<string | null>(null);
  const grantUsedKeyRef = useRef<string | null>(null);

  const walletKey = wallet ? wallet.publicKey : null;
  if (walletKey !== grantUsedKeyRef.current) {
    grantUsedKeyRef.current = walletKey;
    setGrantUsed(readGrantUsed(walletKey));
  }

  const addOwnTag = useCallback((tag: string) => {
    if (!tag || ownTagsRef.current.has(tag)) return;
    ownTagsRef.current.add(tag);
    setOwnTags(new Set(ownTagsRef.current));
  }, []);

  function readRollupSecrets(): Uint8Array[] {
    if (!wallet || client.mode !== "rollup" || typeof window === "undefined") return [];
    return loadTrackedSecrets(window.localStorage, wallet.publicKey).map((entry) =>
      hexToBytes(entry.secretHex),
    );
  }

  // Adjusting state during render (React's documented pattern for resetting
  // derived state when an input changes) rather than in an effect: this
  // store's writes all come from this hook's own callbacks below, which can
  // set state directly; only the "wallet identity changed" case needs to
  // reload it, and that is exactly what this key comparison catches.
  const rollupSecretsKey = wallet ? `${wallet.publicKey}:${client.mode}` : null;
  if (rollupSecretsKey !== rollupSecretsKeyRef.current) {
    rollupSecretsKeyRef.current = rollupSecretsKey;
    setRollupSecrets(readRollupSecrets());
  }

  useEffect(() => {
    if (!wallet) return;
    const identity = walletOf(wallet);
    const unsubscribe = client.subscribe(identity, (next) => {
      setStateSynced(next);
      for (const order of next.openOrders) addOwnTag(order.tag);
    });
    return () => {
      unsubscribe();
      // Wallet changed (cleared, switched) or this component is going away:
      // end the wallet's own live subscription and background refreshes,
      // never left running for a wallet no longer in view.
      client.closeWallet?.(identity);
    };
  }, [client, wallet, addOwnTag, setStateSynced]);

  // The page itself unloading (close, refresh, navigate away) does not
  // always run the effect cleanup above in time; this ends the same
  // subscription from the one event guaranteed to fire first.
  useEffect(() => {
    if (!wallet || typeof window === "undefined") return;
    const identity = walletOf(wallet);
    const onUnload = () => client.closeWallet?.(identity);
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [client, wallet]);

  const effectiveState = wallet ? state : EMPTY_STATE;
  const effectiveLastSyncedAtMs = wallet ? lastSyncedAtMs : null;

  const fund = useCallback(async (): Promise<FundOutcome> => {
    if (!wallet) return { kind: "error", message: "No wallet to fund" };
    const outcome = await client.fund(walletOf(wallet));
    if (outcome.kind === "granted" || outcome.kind === "alreadyFunded") {
      writeGrantUsed(wallet.publicKey);
      setGrantUsed(true);
    }
    return outcome;
  }, [client, wallet]);

  const placeOrder = useCallback(
    async (draft: NewOrderInput): Promise<PlacedOrderOutcome> => {
      if (!wallet) throw new Error("No wallet to trade with");
      const clickedAt = performance.now();
      const result = await client.placeOrder(walletOf(wallet), draft);
      // Rollup mode reports exactly when its result was read from the view
      // (performance.now(), the same clock as clickedAt), which is more
      // precise than timing the whole call from out here: that would also
      // count this function's own promise-resolution overhead.
      const clientDurationMs =
        result.resultAtMs !== undefined
          ? result.resultAtMs - clickedAt
          : performance.now() - clickedAt;
      addOwnTag(result.tag);
      setRollupSecrets(readRollupSecrets());
      // Rollup mode pushes the state an order leaves behind with the result
      // itself; dev mode only polls, so it is asked once, without waiting.
      if (client.mode === "dev") {
        void client.fetchState(walletOf(wallet)).then(setStateSynced, () => {});
      }
      return { result, clientDurationMs };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- readRollupSecrets closes over wallet/client, already deps
    [client, wallet, addOwnTag, setStateSynced],
  );

  const cancelAllInMarket = useCallback(
    async (market: string): Promise<CancelResult> => {
      if (!wallet) throw new Error("No wallet to cancel for");
      return client.cancelAllInMarket(walletOf(wallet), market);
    },
    [client, wallet],
  );

  const syncMarket = useCallback(
    async (market: string) => {
      if (!wallet || !client.syncMarket) return;
      await client.syncMarket(walletOf(wallet), market);
    },
    [client, wallet],
  );

  const cancelOrder = useCallback(
    async (market: string, orderId: string): Promise<CancelResult> => {
      if (!wallet) throw new Error("No wallet to cancel for");
      if (!client.cancelOrder) throw new Error("Per-order cancel is not available");
      return client.cancelOrder(walletOf(wallet), market, orderId);
    },
    [client, wallet],
  );

  const checkPrivacy = useCallback(
    async (market: string) => {
      if (!wallet || !client.checkPrivacy) return null;
      return client.checkPrivacy(walletOf(wallet), market);
    },
    [client, wallet],
  );

  const transferBetweenBalances = useCallback(
    async (toSpot: boolean, amount: string): Promise<TransferResult> => {
      if (!wallet) return { kind: "error", message: "No wallet to transfer for" };
      if (!client.transferBetweenBalances) {
        return { kind: "error", message: "Transfer is not available in this mode" };
      }
      const result = await client.transferBetweenBalances(walletOf(wallet), toSpot, amount);
      if (result.kind === "ok") {
        const next = await client.fetchState(walletOf(wallet));
        setStateSynced(next);
      }
      return result;
    },
    [client, wallet, setStateSynced],
  );

  return {
    client,
    state: effectiveState,
    lastSyncedAtMs: effectiveLastSyncedAtMs,
    ownTags,
    rollupSecrets,
    grantUsed,
    fund,
    placeOrder,
    cancelAllInMarket,
    syncMarket,
    cancelOrder: client.cancelOrder ? cancelOrder : null,
    transferBetweenBalances: client.transferBetweenBalances ? transferBetweenBalances : null,
    checkPrivacy: client.checkPrivacy ? checkPrivacy : null,
  };
}
