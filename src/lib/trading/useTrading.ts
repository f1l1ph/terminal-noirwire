"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createTradingClient } from "./index";
import { generateClientTag } from "./tags";
import type { NewOrderInput, PlaceOrderResult, TraderState, WalletIdentity } from "./types";

const EMPTY_STATE: TraderState = { balances: [], positions: [], openOrders: [], ownFills: [] };

export type NewOrderDraft = Omit<NewOrderInput, "clientOrderId" | "clientTag">;

export interface PlacedOrderOutcome {
  result: PlaceOrderResult;
  /** Click-to-acknowledgement, measured on this device with a monotonic clock. */
  clientDurationMs: number;
}

/**
 * One trading session: the selected trading client (dev today, rollup
 * later), the trader's live state, and the set of client tags this browser
 * has placed, for matching "yours" fills on the public tape.
 */
export function useTrading(address: string | null) {
  const client = useMemo(() => createTradingClient(), []);
  const [state, setState] = useState<TraderState>(EMPTY_STATE);
  const [ownTags, setOwnTags] = useState<ReadonlySet<string>>(new Set());
  const ownTagsRef = useRef<Set<string>>(new Set());

  const addOwnTag = useCallback((tag: string) => {
    if (ownTagsRef.current.has(tag)) return;
    ownTagsRef.current.add(tag);
    setOwnTags(new Set(ownTagsRef.current));
  }, []);

  useEffect(() => {
    if (!address) return;
    const wallet: WalletIdentity = { address };
    return client.subscribe(wallet, (next) => {
      setState(next);
      for (const order of next.openOrders) addOwnTag(order.clientTag);
      for (const fill of next.ownFills) addOwnTag(fill.clientTag);
    });
  }, [client, address, addOwnTag]);

  const effectiveState = address ? state : EMPTY_STATE;

  const fund = useCallback(async () => {
    if (!address) throw new Error("No wallet to fund");
    return client.fund({ address });
  }, [client, address]);

  const placeOrder = useCallback(
    async (draft: NewOrderDraft): Promise<PlacedOrderOutcome> => {
      if (!address) throw new Error("No wallet to trade with");
      const clientTag = generateClientTag();
      const clientOrderId = `${Date.now()}-${clientTag}`;
      addOwnTag(clientTag);
      const clickedAt = performance.now();
      const result = await client.placeOrder({ address }, { ...draft, clientOrderId, clientTag });
      const clientDurationMs = performance.now() - clickedAt;
      return { result, clientDurationMs };
    },
    [client, address, addOwnTag],
  );

  const cancelOrder = useCallback(
    async (market: string, orderId: string) => {
      if (!address) throw new Error("No wallet to cancel for");
      return client.cancelOrder({ address }, market, orderId);
    },
    [client, address],
  );

  const cancelAll = useCallback(
    async (market: string) => {
      if (!address) throw new Error("No wallet to cancel for");
      return client.cancelAll({ address }, market);
    },
    [client, address],
  );

  return { client, state: effectiveState, ownTags, fund, placeOrder, cancelOrder, cancelAll };
}
