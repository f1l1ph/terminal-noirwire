import { isMainnetBuild } from "@/lib/network";
import { MIN_LATENCY_SAMPLE_SIZE, type MarketInfo, type StatsResponse } from "./types";

export function candlesLoadingKey(market: string, interval: string): string {
  return `${market}:${interval}`;
}

/**
 * The market row is fetched once; live marks arrive afterwards over the
 * websocket and land in the store's mark map. This returns the market with
 * its mark taken from whichever of the two is newer (a live mark wins a tie),
 * so a reader of the row never prices from a mark the venue has long replaced.
 */
export function marketWithLiveMark(
  markets: readonly MarketInfo[],
  marksByMarket: Readonly<Record<string, { price: string; time: number } | null | undefined>>,
  id: string,
): MarketInfo | undefined {
  const market = markets.find((item) => item.id === id);
  const live = marksByMarket[id];
  if (!market || !live) return market;
  if (market.markPriceUpdatedAtMs !== null && market.markPriceUpdatedAtMs > live.time) {
    return market;
  }
  return { ...market, markPrice: live.price, markPriceUpdatedAtMs: live.time };
}

/**
 * Mainnet's price crank refreshes the mark about once a minute and the
 * program accepts a mark up to 90 s old, so mainnet allows 75 s: an order
 * placed at the limit still lands inside the program's window.
 */
export const STALE_MARK_MS = isMainnetBuild() ? 75_000 : 10_000;
const STALE_STATS_MS = 30_000;

/** How far ahead of the local clock a server timestamp may be before it is not trusted. */
export const MAX_CLOCK_SKEW_MS = 5_000;

export function isFutureTimestamp(timestamp: number, now: number): boolean {
  return timestamp - now > MAX_CLOCK_SKEW_MS;
}

/** A timestamp from the future has no honest age: it reads as unknown, which every caller treats as stale. */
export function ageMs(updatedAt: number | null | undefined, now: number): number | null {
  if (updatedAt === null || updatedAt === undefined) return null;
  if (isFutureTimestamp(updatedAt, now)) return null;
  return Math.max(now - updatedAt, 0);
}

export function isStale(
  updatedAt: number | null | undefined,
  now: number,
  thresholdMs: number,
): boolean {
  const age = ageMs(updatedAt, now);
  return age === null ? true : age > thresholdMs;
}

export type LatencyDisplay =
  | { status: "unavailable"; lastValidAt: number | null }
  | { status: "insufficient"; sampleSize: number }
  | {
      status: "ok";
      p50Ms: number;
      p99Ms: number;
      sampleSize: number;
      measuredFrom: string;
      updatedAtMs: number;
    };

/**
 * Never carries a "fast" label over stale data: a venue-wide reading past
 * STALE_STATS_MS reports unavailable even if its own numbers once looked
 * good, and a reading below the displayed sample threshold says so with the
 * real count rather than a confident p50/p99. `/v1/stats` has no rolling
 * time window in its wire shape (only `measuredFrom` and a sample size), so
 * this never invents one.
 */
export function latencyDisplay(stats: StatsResponse | null, now: number): LatencyDisplay {
  if (!stats || isStale(stats.updatedAtMs, now, STALE_STATS_MS)) {
    return { status: "unavailable", lastValidAt: stats?.updatedAtMs ?? null };
  }
  if (stats.latency.sampleSize < MIN_LATENCY_SAMPLE_SIZE) {
    return { status: "insufficient", sampleSize: stats.latency.sampleSize };
  }
  return {
    status: "ok",
    p50Ms: stats.latency.medianMs,
    p99Ms: stats.latency.p99Ms,
    sampleSize: stats.latency.sampleSize,
    measuredFrom: stats.latency.measuredFrom,
    updatedAtMs: stats.updatedAtMs,
  };
}
