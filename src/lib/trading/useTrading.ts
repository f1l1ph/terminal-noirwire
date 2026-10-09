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
  const [ownTags, setOwnTags] = useState<ReadonlySet<string>>(new Set());
  const [rollupSecrets, setRollupSecrets] = useState<Uint8Array[]>([]);
  const ownTagsRef = useRef<Set<string>>(new Set());
  const rollupSecretsKeyRef = useRef<string | null>(null);

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
    return client.subscribe(walletOf(wallet), (next) => {
      setState(next);
      for (const order of next.openOrders) addOwnTag(order.tag);
    });
  }, [client, wallet, addOwnTag]);

  const effectiveState = wallet ? state : EMPTY_STATE;

  const fund = useCallback(async (): Promise<FundOutcome> => {
    if (!wallet) return { kind: "error", message: "No wallet to fund" };
    return client.fund(walletOf(wallet));
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
      // A fill changes positions and balances immediately; without this the
      // dock can show the pre-fill state until the next poll tick, up to a
      // second later (seen in a screenshot taken right after "Filled").
      try {
        setState(await client.fetchState(walletOf(wallet)));
      } catch {
        // The regular subscription will catch up; this was a best-effort nudge.
      }
      return { result, clientDurationMs };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- readRollupSecrets closes over wallet/client, already deps
    [client, wallet, addOwnTag],
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
        setState(next);
      }
      return result;
    },
    [client, wallet],
  );

  return {
    client,
    state: effectiveState,
    ownTags,
    rollupSecrets,
    fund,
    placeOrder,
    cancelAllInMarket,
    syncMarket,
    cancelOrder: client.cancelOrder ? cancelOrder : null,
    transferBetweenBalances: client.transferBetweenBalances ? transferBetweenBalances : null,
    checkPrivacy: client.checkPrivacy ? checkPrivacy : null,
  };
}
