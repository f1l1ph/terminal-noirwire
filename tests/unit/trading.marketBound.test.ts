import { describe, expect, it } from "vitest";
import { marketOrderBound } from "@/lib/trading/marketBound";
import { priceOutsideBand } from "@/lib/trading/validation";

const base = { markPrice: "150.000000", tick: "0.01", priceDecimals: 2 };

describe("a reviewed close bound against a mark that moves while the dialog is open", () => {
  const reviewed = marketOrderBound({
    markPrice: "150.00",
    side: "buy",
    tick: "0.01",
    priceDecimals: 2,
    bandBps: 400,
    reduceOnly: true,
  });

  it("builds the reviewed bound at the band edge", () => {
    expect(reviewed).toBe("156.00");
  });

  it("still stands after a move under 50 bps either way when it is inside the band", () => {
    expect(priceOutsideBand("buy", reviewed, "150.60", 400)).toBe(false);
    expect(priceOutsideBand("buy", reviewed, "150.00", 400)).toBe(false);
  });

  it("falls outside the band when the mark moves the other way, which reopens the review", () => {
    expect(priceOutsideBand("buy", reviewed, "149.40", 400)).toBe(true);
    const next = marketOrderBound({
      markPrice: "149.40",
      side: "buy",
      tick: "0.01",
      priceDecimals: 2,
      bandBps: 400,
      reduceOnly: true,
    });
    expect(next).toBe("155.37");
    expect(priceOutsideBand("buy", next, "149.40", 400)).toBe(false);
  });

  it("holds for a sell the other way round", () => {
    const sell = marketOrderBound({
      markPrice: "150.00",
      side: "sell",
      tick: "0.01",
      priceDecimals: 2,
      bandBps: 400,
      reduceOnly: true,
    });
    expect(sell).toBe("144.00");
    expect(priceOutsideBand("sell", sell, "149.40", 400)).toBe(false);
    expect(priceOutsideBand("sell", sell, "150.60", 400)).toBe(true);
  });
});

describe("marketOrderBound", () => {
  it("sits 1% past the mark when no band is known", () => {
    expect(marketOrderBound({ ...base, side: "buy" })).toBe("151.50");
    expect(marketOrderBound({ ...base, side: "sell" })).toBe("148.50");
  });

  it("rounds to the tick away from the mark", () => {
    const coarse = { markPrice: "150.00", priceDecimals: 2, tick: "0.50" };
    expect(marketOrderBound({ ...coarse, side: "buy" })).toBe("151.50");
    expect(marketOrderBound({ ...coarse, markPrice: "150.30", side: "buy" })).toBe("152.00");
    expect(marketOrderBound({ ...coarse, markPrice: "150.30", side: "sell" })).toBe("148.50");
  });

  it("never goes outside a band narrower than 1%", () => {
    expect(marketOrderBound({ ...base, side: "buy", bandBps: 50 })).toBe("150.75");
    expect(marketOrderBound({ ...base, side: "sell", bandBps: 50 })).toBe("149.25");
  });

  it("lets a close reach quotes exactly at both band edges", () => {
    expect(marketOrderBound({ ...base, side: "sell", bandBps: 400, reduceOnly: true })).toBe(
      "144.00",
    );
    expect(marketOrderBound({ ...base, side: "buy", bandBps: 400, reduceOnly: true })).toBe(
      "156.00",
    );
  });

  it("stays inside the band for a mark and tick that do not line up with it", () => {
    const odd = { markPrice: "151.37", tick: "0.05", priceDecimals: 2, bandBps: 400 };
    // 151.37 * 1.04 = 157.4248 and 151.37 * 0.96 = 145.3152.
    expect(marketOrderBound({ ...odd, side: "buy", reduceOnly: true })).toBe("157.40");
    expect(marketOrderBound({ ...odd, side: "sell", reduceOnly: true })).toBe("145.35");
  });

  it("steps back inside the band when rounding away would leave it", () => {
    const wide = { markPrice: "150.00", priceDecimals: 2, tick: "2.00", bandBps: 100 };
    expect(marketOrderBound({ ...wide, side: "buy" })).toBe("150.00");
    expect(marketOrderBound({ ...wide, side: "sell" })).toBe("150.00");
  });
});
