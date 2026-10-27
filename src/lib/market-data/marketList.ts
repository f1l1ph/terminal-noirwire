import { z } from "zod";
import { keepLastKnown, loadLastKnown } from "../lastKnown";
import { marketInfoSchema, type MarketInfo } from "../sim-api/schema";
import type { KeyValueStore } from "../wallet/index";
import { loadWithRetry } from "./retry";
import type { MarketDataStore } from "./store";

const MARKETS_NAME = "markets";
const keptMarketsSchema = z.array(marketInfoSchema);

/**
 * The market settings worth keeping: what a session needs to bind against
 * (ids, ticks, lots, leverage). Everything that was only true at one moment
 * is dropped, so a kept copy can never show an old price as a current one.
 */
export function settingsOnly(markets: MarketInfo[]): MarketInfo[] {
  return markets.map((market) => ({
    ...market,
    markPrice: null,
    markPriceUpdatedAtMs: null,
    change24hPercent: null,
    volume24h: "0",
    openInterest: null,
  }));
}

interface MarketListOptions {
  store: MarketDataStore;
  simUrl: string;
  storage: KeyValueStore;
  fetchMarkets: (simUrl: string) => Promise<MarketInfo[]>;
  isCancelled: () => boolean;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Asks for the market list until it arrives. The first failure puts the
 * last list this browser kept (if any) into the store, so trading can start;
 * the live list replaces it the moment it answers, and is kept in its place.
 */
export async function loadMarketList({
  store,
  simUrl,
  storage,
  fetchMarkets,
  isCancelled,
  sleep,
}: MarketListOptions): Promise<void> {
  let triedKept = false;
  const markets = await loadWithRetry(() => fetchMarkets(simUrl), {
    isCancelled,
    sleep,
    onFailure: () => {
      if (triedKept) return;
      triedKept = true;
      const kept = loadLastKnown(storage, MARKETS_NAME, simUrl, keptMarketsSchema);
      if (kept && kept.length > 0 && store.getState().markets.length === 0) {
        store.setMarketsFromKept(kept);
      } else {
        store.setMarketsUnreachable(true);
      }
    },
  });
  if (!markets || isCancelled()) return;
  keepLastKnown(storage, MARKETS_NAME, simUrl, settingsOnly(markets));
  store.setMarkets(markets);
}
