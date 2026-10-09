import { describe, expect, it } from "vitest";
import { MarketDataStore } from "@/lib/market-data/store";
import type { PublicFill } from "@/lib/market-data/types";

function fill(overrides: Partial<PublicFill> = {}): PublicFill {
  return {
    market: "NSOL-PERP",
    price: "150.000000",
    size: "1.000000",
    takerSide: "buy",
    takerTag: "111",
    makerTag: "222",
    timestampMs: 1000,
    sequence: 1,
    ...overrides,
  };
}

describe("MarketDataStore", () => {
  it("prepends new fills to the tape, newest first, capped at 200 rows", () => {
    const store = new MarketDataStore();
    store.setInitialTape("NSOL-PERP", [fill({ sequence: 1 })]);
    store.applyMessage({ type: "fill", ...fill({ sequence: 2 }) });
    const tape = store.getState().tapeByMarket["NSOL-PERP"];
    expect(tape?.map((row) => row.sequence)).toEqual([2, 1]);
  });

  it("ignores a price update older than the one it already has", () => {
    const store = new MarketDataStore();
    store.applyMessage({
      type: "price",
      market: "NSOL-PERP",
      price: "150.000000",
      publishedAtMs: 2000,
    });
    store.applyMessage({
      type: "price",
      market: "NSOL-PERP",
      price: "9999.000000",
      publishedAtMs: 1000,
    });
    expect(store.getState().marksByMarket["NSOL-PERP"]).toEqual({
      price: "150.000000",
      time: 2000,
    });
  });

  it("notifies subscribers exactly once per state change", () => {
    const store = new MarketDataStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    store.setConnectionState("open");
    store.setConnectionState("open");
    unsubscribe();
    store.setConnectionState("reconnecting");
    expect(notifications).toBe(1);
  });

  it("replaces the in-progress candle instead of duplicating it", () => {
    const store = new MarketDataStore();
    store.setInitialCandles("NSOL-PERP", "1m", [
      { startMs: 60, open: "1", high: "1", low: "1", close: "1", volume: "1" },
    ]);
    store.applyMessage({
      type: "candle",
      market: "NSOL-PERP",
      interval: "1m",
      candle: { startMs: 60, open: "1", high: "2", low: "1", close: "2", volume: "3" },
    });
    const candles = store.getState().candlesByMarket["NSOL-PERP"]?.["1m"];
    expect(candles).toHaveLength(1);
    expect(candles?.[0].close).toBe("2");
  });

  it("tracks candle loading per market and interval independently", () => {
    const store = new MarketDataStore();
    store.setCandlesLoading("NSOL-PERP", "1m", true);
    store.setCandlesLoading("NSOL-NUSD", "1m", true);
    store.setCandlesLoading("NSOL-PERP", "1m", false);
    expect(store.getState().candlesLoading["NSOL-PERP:1m"]).toBe(false);
    expect(store.getState().candlesLoading["NSOL-NUSD:1m"]).toBe(true);
  });
});
