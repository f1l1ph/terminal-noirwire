import { MIN_LATENCY_SAMPLE_SIZE, type StatsResponse } from "./types";

export function candlesLoadingKey(market: string, interval: string): string {
  return `${market}:${interval}`;
}

export const STALE_MARK_MS = 10_000;
export const STALE_STATS_MS = 30_000;

export function ageMs(updatedAt: number | null | undefined, now: number): number | null {
  if (updatedAt === null || updatedAt === undefined) return null;
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
