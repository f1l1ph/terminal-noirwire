import { MIN_LATENCY_SAMPLE_SIZE, type VenueStats } from "./types";

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
  | { status: "insufficient"; sampleCount: number }
  | {
      status: "ok";
      p50Ms: number;
      p99Ms: number;
      sampleCount: number;
      windowStart: number;
      windowEnd: number;
      updatedAt: number;
    };

/**
 * Never carries a "fast" label over stale data: a venue-wide reading past
 * STALE_STATS_MS reports unavailable even if its own numbers once looked
 * good, and a reading below the displayed sample threshold says so with the
 * real count rather than a confident p50/p99.
 */
export function latencyDisplay(stats: VenueStats | null, now: number): LatencyDisplay {
  if (!stats || isStale(stats.updatedAt, now, STALE_STATS_MS)) {
    return { status: "unavailable", lastValidAt: stats?.updatedAt ?? null };
  }
  if (
    stats.latency.sampleCount < MIN_LATENCY_SAMPLE_SIZE ||
    stats.latency.p50Ms === null ||
    stats.latency.p99Ms === null
  ) {
    return { status: "insufficient", sampleCount: stats.latency.sampleCount };
  }
  return {
    status: "ok",
    p50Ms: stats.latency.p50Ms,
    p99Ms: stats.latency.p99Ms,
    sampleCount: stats.latency.sampleCount,
    windowStart: stats.latency.windowStart,
    windowEnd: stats.latency.windowEnd,
    updatedAt: stats.updatedAt,
  };
}
