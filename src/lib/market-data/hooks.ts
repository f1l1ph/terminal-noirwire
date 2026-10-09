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
 * with reconnect and backoff. sim-noirwire's stream is scoped to one
 * market per connection (`WS /v1/stream?market=`), so switching the
 * selected market closes the old socket and opens a new one; `stats`
 * messages go to every connected socket regardless of its market, so
 * nothing is lost across that reconnect.
 */
export function useMarketDataConnection(
  store: MarketDataStore,
  simUrl: string,
  simWsUrl: string,
  selectedMarket: string,
  interval: CandleInterval,
  retryToken = 0,
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
    store.setCandlesLoading(selectedMarket, interval, true);
    fetchCandles(simUrl, selectedMarket, interval)
      .then((candles) => {
        if (!cancelled) store.setInitialCandles(selectedMarket, interval, candles);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) store.setCandlesLoading(selectedMarket, interval, false);
      });
    return () => {
      cancelled = true;
    };
  }, [store, simUrl, selectedMarket, interval, retryToken]);

  useEffect(() => {
    let cancelled = false;
    fetchStats(simUrl)
      .then((stats) => {
        if (!cancelled) store.setStats(stats);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [store, simUrl]);

  useEffect(() => {
    const url = `${simWsUrl}?market=${encodeURIComponent(selectedMarket)}`;
    const socket = new MarketSocket(
      url,
      {
        onMessage: (message) => store.applyMessage(message),
        onStateChange: (state) => store.setConnectionState(state),
      },
      { createSocket: createBrowserWebSocket },
    );
    socket.connect();
    return () => socket.close();
  }, [store, simWsUrl, selectedMarket]);
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
