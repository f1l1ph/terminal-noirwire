"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { fetchCandles, fetchMarkets, fetchStats, fetchTape } from "./client";
import { browserLocalStorage } from "../wallet/index";
import { loadMarketList } from "./marketList";
import { loadWithRetry } from "./retry";
import { MarketSocket, type WebSocketLike } from "./socket";
import { MarketDataStore, type MarketDataState } from "./store";
import type { CandleInterval } from "./types";

/** The tape, candles and stats are asked for this many times before the live stream is left to fill them in; the market list is asked for until it arrives. */
const SECONDARY_ATTEMPTS = 6;

export function useMarketDataState(store: MarketDataStore): MarketDataState {
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getState(),
    () => store.getState(),
  );
}

/**
 * Wires one MarketDataStore to the simulation service: fetches markets,
 * tape and candles (asking again, with growing waits, while the service
 * does not answer), then keeps everything live over one websocket
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
): void {
  useEffect(() => {
    let cancelled = false;
    const isCancelled = () => cancelled;
    void loadMarketList({
      store,
      simUrl,
      storage: browserLocalStorage(),
      fetchMarkets,
      isCancelled,
    });
    return () => {
      cancelled = true;
    };
  }, [store, simUrl]);

  useEffect(() => {
    let cancelled = false;
    const options = { isCancelled: () => cancelled, maxAttempts: SECONDARY_ATTEMPTS };
    void loadWithRetry(() => fetchTape(simUrl, selectedMarket), options).then((tape) => {
      if (tape && !cancelled) store.setInitialTape(selectedMarket, tape);
    });
    store.setCandlesLoading(selectedMarket, interval, true);
    void loadWithRetry(() => fetchCandles(simUrl, selectedMarket, interval), options).then(
      (candles) => {
        if (cancelled) return;
        if (candles) store.setInitialCandles(selectedMarket, interval, candles);
        store.setCandlesLoading(selectedMarket, interval, false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [store, simUrl, selectedMarket, interval]);

  useEffect(() => {
    let cancelled = false;
    void loadWithRetry(() => fetchStats(simUrl), {
      isCancelled: () => cancelled,
      maxAttempts: SECONDARY_ATTEMPTS,
    }).then((stats) => {
      if (stats && !cancelled) store.setStats(stats);
    });
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
