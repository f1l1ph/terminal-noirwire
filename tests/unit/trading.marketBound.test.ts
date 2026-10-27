import { describe, expect, it } from "vitest";
import { marketOrderBound } from "@/lib/trading/marketBound";

const base = { markPrice: "150.000000", tick: "0.01", priceDecimals: 2 };

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

  it("gives a close most of the band so it still finds a fill", () => {
    expect(marketOrderBound({ ...base, side: "sell", bandBps: 400, reduceOnly: true })).toBe(
      "144.60",
    );
    expect(marketOrderBound({ ...base, side: "buy", bandBps: 400, reduceOnly: true })).toBe(
      "155.40",
    );
  });

  it("steps back inside the band when rounding away would leave it", () => {
    const wide = { markPrice: "150.00", priceDecimals: 2, tick: "2.00", bandBps: 100 };
    expect(marketOrderBound({ ...wide, side: "buy" })).toBe("150.00");
    expect(marketOrderBound({ ...wide, side: "sell" })).toBe("150.00");
  });
});
