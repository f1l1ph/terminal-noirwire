import { describe, expect, it } from "vitest";
import {
  ageMs,
  isStale,
  latencyDisplay,
  marketWithLiveMark,
  MAX_CLOCK_SKEW_MS,
  STALE_MARK_MS,
} from "@/lib/market-data/selectors";
import type { MarketInfo, StatsResponse } from "@/lib/market-data/types";

function stats(overrides: Partial<StatsResponse> = {}): StatsResponse {
  return {
    network: "devnet",
    orders: { user: 40, bot: 60 },
    fills: { user: 20, bot: 60 },
    volume: { user: "1000.000000", bot: "5000.000000" },
    tradersTotal: 5,
    latency: {
      medianMs: 420,
      p99Ms: 910,
      sampleSize: 184,
      measuredFrom: "http:request",
    },
    updatedAtMs: 900_000,
    ...overrides,
  };
}

describe("a timestamp from the future", () => {
  const now = 1_000_000;

  it("reads as an unknown age and so as stale, never as fresh", () => {
    const future = now + MAX_CLOCK_SKEW_MS + 1;
    expect(ageMs(future, now)).toBeNull();
    expect(isStale(future, now, STALE_MARK_MS)).toBe(true);
  });

  it("tolerates a small clock skew as age zero", () => {
    expect(ageMs(now + MAX_CLOCK_SKEW_MS, now)).toBe(0);
    expect(isStale(now + 1000, now, STALE_MARK_MS)).toBe(false);
  });
});

describe("latencyDisplay", () => {
  it("reports ok with the measured figures when fresh and well sampled", () => {
    const result = latencyDisplay(stats(), 900_500);
    expect(result).toMatchObject({ status: "ok", p50Ms: 420, p99Ms: 910, sampleSize: 184 });
  });

  it("reports insufficient when the sample size is below the threshold", () => {
    const result = latencyDisplay(
      stats({
        latency: { medianMs: 420, p99Ms: 910, sampleSize: 4, measuredFrom: "http:request" },
      }),
      900_500,
    );
    expect(result).toEqual({ status: "insufficient", sampleSize: 4 });
  });

  it("reports unavailable once the reading is stale, never a stale fast label", () => {
    const result = latencyDisplay(stats({ updatedAtMs: 0 }), 900_000);
    expect(result.status).toBe("unavailable");
  });

  it("reports unavailable with no stats at all", () => {
    expect(latencyDisplay(null, 1000)).toEqual({ status: "unavailable", lastValidAt: null });
  });
});

describe("marketWithLiveMark", () => {
  const row: MarketInfo = {
    id: "NSOL-PERP",
    kind: "perp",
    base: "SOL",
    quote: "nUSD",
    tickSize: "0.010000",
    lotSize: "0.001000",
    maxLeverage: 10,
    markPrice: "150.000000",
    markPriceUpdatedAtMs: 1_000,
    change24hPercent: 0,
    volume24h: "0",
    openInterest: "0",
  };

  it("takes the price and time of a newer live mark", () => {
    const live = { "NSOL-PERP": { price: "151.500000", time: 5_000 } };
    const market = marketWithLiveMark([row], live, "NSOL-PERP");
    expect(market).toMatchObject({
      markPrice: "151.500000",
      markPriceUpdatedAtMs: 5_000,
      maxLeverage: 10,
    });
  });

  it("ignores a live mark older than the row's", () => {
    const live = { "NSOL-PERP": { price: "99.000000", time: 500 } };
    expect(marketWithLiveMark([row], live, "NSOL-PERP")).toBe(row);
  });

  it("falls back to the row when there is no live mark", () => {
    expect(marketWithLiveMark([row], {}, "NSOL-PERP")).toBe(row);
    expect(marketWithLiveMark([row], { "NSOL-PERP": null }, "NSOL-PERP")).toBe(row);
  });

  it("uses a live mark when the row has none", () => {
    const bare = { ...row, markPrice: null, markPriceUpdatedAtMs: null };
    const live = { "NSOL-PERP": { price: "152.000000", time: 2_000 } };
    const market = marketWithLiveMark([bare], live, "NSOL-PERP");
    expect(market).toMatchObject({ markPrice: "152.000000", markPriceUpdatedAtMs: 2_000 });
  });

  it("returns undefined for an unknown market", () => {
    expect(marketWithLiveMark([row], { OTHER: { price: "1", time: 1 } }, "OTHER")).toBeUndefined();
  });
});
