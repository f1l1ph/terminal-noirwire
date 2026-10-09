"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createTradingClient } from "./index";
import type {
  FundOutcome,
  NewOrderInput,
  PlaceOrderResult,
  TraderState,
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

/**
 * One trading session: the selected trading client (dev today, rollup
 * later), the trader's live state, and the set of venue-assigned order tags
 * this browser has learned (from its own placeOrder responses and its own
 * open orders), for matching "yours" fills on the public tape. See
 * `src/lib/trading/tags.ts`.
 */
export function useTrading(address: string | null) {
  const client = useMemo(() => createTradingClient(), []);
  const [state, setState] = useState<TraderState>(EMPTY_STATE);
  const [ownTags, setOwnTags] = useState<ReadonlySet<string>>(new Set());
  const ownTagsRef = useRef<Set<string>>(new Set());

  const addOwnTag = useCallback((tag: string) => {
    if (!tag || ownTagsRef.current.has(tag)) return;
    ownTagsRef.current.add(tag);
    setOwnTags(new Set(ownTagsRef.current));
  }, []);

  useEffect(() => {
    if (!address) return;
    const wallet: WalletIdentity = { address };
    return client.subscribe(wallet, (next) => {
      setState(next);
      for (const order of next.openOrders) addOwnTag(order.tag);
    });
  }, [client, address, addOwnTag]);

  const effectiveState = address ? state : EMPTY_STATE;

  const fund = useCallback(async (): Promise<FundOutcome> => {
    if (!address) return { kind: "error", message: "No wallet to fund" };
    return client.fund({ address });
  }, [client, address]);

  const placeOrder = useCallback(
    async (draft: NewOrderInput): Promise<PlacedOrderOutcome> => {
      if (!address) throw new Error("No wallet to trade with");
      const clickedAt = performance.now();
      const result = await client.placeOrder({ address }, draft);
      const clientDurationMs = performance.now() - clickedAt;
      addOwnTag(result.tag);
      return { result, clientDurationMs };
    },
    [client, address, addOwnTag],
  );

  const cancelAllInMarket = useCallback(
    async (market: string) => {
      if (!address) throw new Error("No wallet to cancel for");
      return client.cancelAllInMarket({ address }, market);
    },
    [client, address],
  );

  return { client, state: effectiveState, ownTags, fund, placeOrder, cancelAllInMarket };
}
