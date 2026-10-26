"use client";

import { useEffect, useState } from "react";
import {
  fetchReferenceHistory,
  REFERENCE_REFRESH_MS,
  type HistoryRange,
  type ReferenceCandle,
} from "./reference-history";

interface CacheEntry {
  candles: ReferenceCandle[];
  fetchedAt: number;
}

/** One entry per range, shared by every component that reads the same range. */
const cache = new Map<HistoryRange, CacheEntry>();
const inFlight = new Map<HistoryRange, Promise<CacheEntry>>();

/** Slightly under the refresh period, so a timer tick one second early still refreshes. */
const FRESH_FOR_MS = REFERENCE_REFRESH_MS - 5_000;

/** Not tied to any one component's abort signal: the request is shared by every reader of the range. */
function loadRange(range: HistoryRange): Promise<CacheEntry> {
  const cached = cache.get(range);
  if (cached && Date.now() - cached.fetchedAt < FRESH_FOR_MS) {
    return Promise.resolve(cached);
  }
  const pending = inFlight.get(range);
  if (pending) return pending;
  const request = fetchReferenceHistory(range).then((candles) => {
    const entry = { candles, fetchedAt: Date.now() };
    cache.set(range, entry);
    return entry;
  });
  inFlight.set(range, request);
  const clear = () => inFlight.delete(range);
  request.then(clear, clear);
  return request;
}

export interface ReferenceHistoryState {
  /** The last good series for this range, kept while a refresh fails. Empty when none was ever loaded. */
  candles: ReferenceCandle[];
  status: "loading" | "ready" | "unavailable";
}

const LOADING: ReferenceHistoryState = { candles: [], status: "loading" };

/**
 * The reference series for `range`, refreshed gently (at most once a
 * minute, and not while the tab is hidden). A failed fetch never produces
 * a made-up line: it keeps the last good series if there is one, otherwise
 * reports "unavailable".
 */
export function useReferenceHistory(range: HistoryRange): ReferenceHistoryState {
  const [state, setState] = useState<{ range: HistoryRange; value: ReferenceHistoryState }>({
    range,
    value: LOADING,
  });

  useEffect(() => {
    let cancelled = false;

    const refresh = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      loadRange(range).then(
        (entry) => {
          if (!cancelled) setState({ range, value: { candles: entry.candles, status: "ready" } });
        },
        () => {
          if (cancelled) return;
          const last = cache.get(range);
          setState({
            range,
            value: last
              ? { candles: last.candles, status: "ready" }
              : { candles: [], status: "unavailable" },
          });
        },
      );
    };

    refresh();
    const timer = setInterval(refresh, REFERENCE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [range]);

  return state.range === range ? state.value : LOADING;
}
