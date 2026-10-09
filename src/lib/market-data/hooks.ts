"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { fetchCandles, fetchMarkets, fetchStats, fetchTape } from "./client";
import { MarketSocket, type WebSocketLike } from "./socket";
import { MarketDataStore, type MarketDataState } from "./store";
import type { CandleInterval } from "./types";

export function useMarketDataState(store: MarketDataStore): MarketDataState {
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getState(),
    () => store.getState(),
  );
}

/**
 * Wires one MarketDataStore to the simulation service: fetches markets,
 * tape and candles once, then keeps everything live over one websocket
 * with reconnect and backoff. Created once per terminal session.
 */
export function useMarketDataConnection(
  store: MarketDataStore,
  simUrl: string,
  simWsUrl: string,
  selectedMarket: string,
  interval: CandleInterval,
): void {
  useEffect(() => {
    let cancelled = false;
    fetchMarkets(simUrl)
      .then((markets) => {
        if (!cancelled) store.setMarkets(markets);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [store, simUrl]);

  useEffect(() => {
    let cancelled = false;
    fetchTape(simUrl, selectedMarket)
      .then((tape) => {
        if (!cancelled) store.setInitialTape(selectedMarket, tape);
      })
      .catch(() => {});
    fetchCandles(simUrl, selectedMarket, interval)
      .then((candles) => {
        if (!cancelled) store.setInitialCandles(selectedMarket, interval, candles);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [store, simUrl, selectedMarket, interval]);

  useEffect(() => {
    let cancelled = false;
    fetchStats(simUrl)
      .then((stats) => {
        if (!cancelled) store.applyMessage({ type: "stats", stats });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [store, simUrl]);

  useEffect(() => {
    const socket = new MarketSocket(
      simWsUrl,
      {
        onMessage: (message) => store.applyMessage(message),
        onStateChange: (state) => store.setConnectionState(state),
      },
      { createSocket: createBrowserWebSocket },
    );
    socket.connect();
    return () => socket.close();
  }, [store, simWsUrl]);
}

export function useSharedMarketDataStore(): MarketDataStore {
  return useMemo(() => new MarketDataStore(), []);
}

/** Adapts the browser's native WebSocket to the minimal shape MarketSocket needs. */
function createBrowserWebSocket(url: string): WebSocketLike {
  const native = new WebSocket(url);
  const facade: WebSocketLike = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    close: () => native.close(),
  };
  native.onopen = () => facade.onopen?.();
  native.onmessage = (event) => facade.onmessage?.({ data: event.data });
  native.onclose = () => facade.onclose?.();
  native.onerror = () => facade.onerror?.();
  return facade;
}
