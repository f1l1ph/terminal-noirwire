import { describe, expect, it } from "vitest";
import {
  MARGIN_REFRESH_AFTER_EXPIRY_MS,
  MARGIN_REFRESH_LEAD_MS,
  MARGIN_REFRESH_MIN_SPACING_MS,
  MARGIN_REFRESH_STALE_RETRY_MS,
  nextMarginRefreshDelayMs,
} from "@/lib/trading/marginRefresh";

const NOW = 1_000_000;

/** Plays `count` re-reads forward against a mark that never moves, returning when each happens. */
function readTimesWithFrozenMark(validUntilMs: number, startMs: number, count = 4): number[] {
  const reads: number[] = [];
  let clock = startMs;
  let lastReadAtMs: number | null = null;
  for (let step = 0; step < count; step += 1) {
    const delay = nextMarginRefreshDelayMs(validUntilMs, clock, lastReadAtMs);
    clock += delay;
    reads.push(clock);
    lastReadAtMs = clock;
  }
  return reads;
}

describe("nextMarginRefreshDelayMs", () => {
  it("re-reads a lead time before the figure goes stale", () => {
    const validUntilMs = NOW + 60_000;
    expect(nextMarginRefreshDelayMs(validUntilMs, NOW, null)).toBe(60_000 - MARGIN_REFRESH_LEAD_MS);
  });

  it("re-reads at once when the lead window has already begun", () => {
    expect(nextMarginRefreshDelayMs(NOW + 3_000, NOW, null)).toBe(0);
  });

  it("never returns a negative delay for a figure already stale", () => {
    expect(nextMarginRefreshDelayMs(NOW - 5_000, NOW, null)).toBe(0);
  });

  it("with the mark frozen, reads early, just after expiry, then slowly while stale", () => {
    const validUntilMs = NOW + 60_000;
    const reads = readTimesWithFrozenMark(validUntilMs, NOW);
    const afterExpiry = validUntilMs + MARGIN_REFRESH_AFTER_EXPIRY_MS;
    expect(reads).toEqual([
      validUntilMs - MARGIN_REFRESH_LEAD_MS,
      afterExpiry,
      afterExpiry + MARGIN_REFRESH_STALE_RETRY_MS,
      afterExpiry + 2 * MARGIN_REFRESH_STALE_RETRY_MS,
    ]);
  });

  it("keeps the minimum spacing between reads when the figure is about to expire", () => {
    const validUntilMs = NOW + 1_000;
    const reads = readTimesWithFrozenMark(validUntilMs, NOW, 10);
    for (let i = 1; i < reads.length; i += 1) {
      expect(reads[i] - reads[i - 1]).toBeGreaterThanOrEqual(MARGIN_REFRESH_MIN_SPACING_MS);
    }
  });

  it("retries a stale figure no sooner than the stale retry interval", () => {
    expect(nextMarginRefreshDelayMs(NOW, NOW + 1_000, NOW + 500)).toBe(
      MARGIN_REFRESH_STALE_RETRY_MS - 500,
    );
  });
});
