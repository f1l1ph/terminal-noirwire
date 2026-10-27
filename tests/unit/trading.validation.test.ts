import { describe, expect, it } from "vitest";
import {
  describeFieldError,
  describeRejectReason,
  MAX_LIMIT_PRICE_DEVIATION_BPS,
  MAX_REVIEW_MARK_MOVE_BPS,
  markMovedMaterially,
  validateOrder,
} from "@/lib/trading/validation";
import { STALE_MARK_MS } from "@/lib/market-data/selectors";
import type { MarketInfo } from "@/lib/market-data/types";

const PERP_MARKET: MarketInfo = {
  id: "NSOL-PERP",
  kind: "perp",
  base: "NSOL",
  quote: "nUSD",
  tickSize: "0.010000",
  lotSize: "0.100000",
  maxLeverage: 20,
  markPrice: "150.000000",
  markPriceUpdatedAtMs: 0,
  change24hPercent: 0,
  volume24h: "0",
  openInterest: "0",
};

const NOW = 1_000_000;
const MARK = { price: "150.000000", time: NOW };

describe("validateOrder: quantity", () => {
  it("accepts a quantity that is a multiple of the lot size", () => {
    const result = validateOrder({ price: "150.00", size: "1.0" }, PERP_MARKET, MARK, NOW);
    expect(result.errors.quantity).toBeUndefined();
  });

  it("rejects a quantity that is not a multiple of the lot size", () => {
    const result = validateOrder({ price: "150.00", size: "1.05" }, PERP_MARKET, MARK, NOW);
    expect(result.errors.quantity).toBe("quantityNotMultipleOfLot");
  });

  it("rejects a quantity below the market's lot size (the minimum)", () => {
    const result = validateOrder(
      { price: "150.00", size: "0.05" },
      { ...PERP_MARKET, lotSize: "0.100000" },
      MARK,
      NOW,
    );
    expect(result.errors.quantity).toBe("quantityNotMultipleOfLot");
  });

  it("rejects a blank quantity", () => {
    const result = validateOrder({ price: "150.00", size: "" }, PERP_MARKET, MARK, NOW);
    expect(result.errors.quantity).toBe("quantityRequired");
    expect(result.valid).toBe(false);
  });
});

describe("validateOrder: price", () => {
  it("rejects a price that is not a multiple of the tick size", () => {
    const result = validateOrder({ price: "150.005", size: "1.0" }, PERP_MARKET, MARK, NOW);
    expect(result.errors.price).toBe("priceNotMultipleOfTick");
  });

  it("requires a price for every order type (the venue has no unprotected market order)", () => {
    const result = validateOrder({ price: "", size: "1.0" }, PERP_MARKET, MARK, NOW);
    expect(result.errors.price).toBe("priceRequired");
  });

  it("rejects a non-positive price", () => {
    const result = validateOrder({ price: "0", size: "1.0" }, PERP_MARKET, MARK, NOW);
    expect(result.errors.price).toBe("priceNotPositive");
  });

  it("accepts a valid price and quantity together", () => {
    const result = validateOrder({ price: "150.00", size: "1.0" }, PERP_MARKET, MARK, NOW);
    expect(result.valid).toBe(true);
  });
});

describe("validateOrder: the market account's own limits", () => {
  const LIMITS = { bandBps: 400, minSize: "0.300000", minNotional: "50.000000" };
  const check = (
    side: "buy" | "sell",
    price: string,
    size = "1.0",
    limits: typeof LIMITS | undefined = LIMITS,
  ) => validateOrder({ side, price, size }, PERP_MARKET, MARK, NOW, false, limits);

  it("allows a bid exactly 4% above the mark and refuses one tick more", () => {
    expect(check("buy", "156.00").valid).toBe(true);
    expect(check("buy", "156.01").errors.price).toBe("bidAboveBand");
  });

  it("allows an ask exactly 4% below the mark and refuses one tick more", () => {
    expect(check("sell", "144.00").valid).toBe(true);
    expect(check("sell", "143.99").errors.price).toBe("askBelowBand");
  });

  it("lets a passive price through on either side, up to the outer limit", () => {
    expect(check("buy", "140.00").valid).toBe(true);
    expect(check("sell", "160.00").valid).toBe(true);
  });

  it("keeps the outer limit ahead of the band", () => {
    expect(check("buy", "200.00").errors.price).toBe("priceTooFarFromMark");
  });

  it("waits for the program when the band is not known yet", () => {
    const unchecked = validateOrder(
      { side: "buy", price: "160.00", size: "1.0" },
      PERP_MARKET,
      MARK,
      NOW,
    );
    expect(unchecked.valid).toBe(true);
  });

  it("names the limit in plain words", () => {
    expect(describeFieldError("bidAboveBand", PERP_MARKET, LIMITS)).toBe(
      "A buy can be at most 4% above the mark price.",
    );
    expect(describeFieldError("askBelowBand", PERP_MARKET, LIMITS)).toBe(
      "A sell can be at most 4% below the mark price.",
    );
  });

  it("refuses a size under the chain's minimum and prints the minimum", () => {
    const result = check("buy", "150.00", "0.2");
    expect(result.errors.quantity).toBe("quantityBelowMinimum");
    expect(describeFieldError("quantityBelowMinimum", PERP_MARKET, LIMITS)).toBe(
      "Minimum order is 0.3 NSOL.",
    );
  });

  it("refuses an order worth less than the chain's minimum value and prints it", () => {
    expect(check("buy", "150.00", "0.4").valid).toBe(true);
    const small = check("buy", "10.00", "0.3", { ...LIMITS, bandBps: 10_000 });
    expect(small.errors.quantity).toBe("notionalBelowMinimum");
    expect(describeFieldError("notionalBelowMinimum", PERP_MARKET, LIMITS)).toBe(
      "Minimum order value is 50 nUSD. Raise the size or the price.",
    );
  });

  it("falls back to the lot size as the minimum without chain limits", () => {
    expect(describeFieldError("quantityBelowMinimum", PERP_MARKET)).toBe(
      "Minimum order is 0.1 NSOL.",
    );
  });
});

describe("validateOrder: price band around the mark", () => {
  const check = (price: string, mark: typeof MARK | null | undefined = MARK) =>
    validateOrder({ price, size: "1.0" }, PERP_MARKET, mark, NOW);

  it("allows a price exactly at the maximum deviation, above and below", () => {
    expect(MAX_LIMIT_PRICE_DEVIATION_BPS).toBe(1000);
    expect(check("165.00").valid).toBe(true);
    expect(check("135.00").valid).toBe(true);
  });

  it("refuses a price one tick beyond the maximum deviation", () => {
    expect(check("165.01").errors.price).toBe("priceTooFarFromMark");
    expect(check("134.99").errors.price).toBe("priceTooFarFromMark");
  });

  it("refuses a 10x typo on a market-order bound", () => {
    const result = check("1515.00");
    expect(result.valid).toBe(false);
    expect(result.errors.price).toBe("priceTooFarFromMark");
  });

  it("keeps the default 1% market bound valid", () => {
    expect(check("151.50").valid).toBe(true);
  });

  it("refuses any order when there is no usable mark to check against", () => {
    for (const price of [null, undefined, "", "0", "abc"]) {
      const mark = price === null || price === undefined ? price : { price, time: NOW };
      const result = validateOrder({ price: "150.00", size: "1.0" }, PERP_MARKET, mark, NOW);
      expect(result.errors.price).toBe("markUnavailable");
    }
  });

  it("explains the errors in plain language", () => {
    expect(describeFieldError("priceTooFarFromMark", PERP_MARKET)).toContain("10%");
    const noPrice = describeFieldError("markUnavailable", PERP_MARKET);
    expect(noPrice).toContain("no price for SOL-PERP yet");
    expect(noPrice).toContain("Your funds are safe");
    expect(describeFieldError("markStale", PERP_MARKET)).toContain("too old");
  });

  it("refuses a limit order priced near a mark that is older than the stale limit", () => {
    const stale = { price: "150.000000", time: NOW - STALE_MARK_MS - 1 };
    const result = check("149.25", stale);
    expect(result.valid).toBe(false);
    expect(result.errors.price).toBe("markStale");
  });

  it("accepts a stale mark when the caller allows it, and still holds the band against it", () => {
    const stale = { price: "150.000000", time: NOW - STALE_MARK_MS - 1 };
    const allowed = (price: string) =>
      validateOrder({ price, size: "1.0" }, PERP_MARKET, stale, NOW, true);
    expect(allowed("149.25").valid).toBe(true);
    expect(allowed("200.00").errors.price).toBe("priceTooFarFromMark");
  });

  it("still refuses a missing mark when a stale one is allowed", () => {
    expect(
      validateOrder({ price: "149.25", size: "1.0" }, PERP_MARKET, null, NOW, true).valid,
    ).toBe(false);
  });

  it("accepts the same order when the mark is exactly at the stale limit", () => {
    const edge = { price: "150.000000", time: NOW - STALE_MARK_MS };
    expect(check("149.25", edge).valid).toBe(true);
  });

  it("refuses an order against a mark stamped in the future", () => {
    const future = { price: "150.000000", time: NOW + 3_600_000 };
    expect(check("150.00", future).errors.price).toBe("markStale");
  });

  it("holds the band on a market with a half-unit tick and a large price", () => {
    const market = { ...PERP_MARKET, tickSize: "0.500000", lotSize: "0.001000" };
    const mark = { price: "65000.500000", time: NOW };
    const at = (price: string) => validateOrder({ price, size: "0.001" }, market, mark, NOW);
    expect(at("71500.50").valid).toBe(true);
    expect(at("71501.00").errors.price).toBe("priceTooFarFromMark");
    expect(at("58500.50").valid).toBe(true);
    expect(at("58500.00").errors.price).toBe("priceTooFarFromMark");
    expect(at("65000.25").errors.price).toBe("priceNotMultipleOfTick");
  });

  it("holds the band on a sub-cent token with a fine tick and a coarse lot", () => {
    const market = {
      ...PERP_MARKET,
      id: "NTINY-NUSD",
      kind: "spot" as const,
      tickSize: "0.000001",
      lotSize: "1000.000000",
    };
    const mark = { price: "0.000123", time: NOW };
    const at = (price: string) => validateOrder({ price, size: "1000" }, market, mark, NOW);
    expect(at("0.000135").valid).toBe(true);
    expect(at("0.000136").errors.price).toBe("priceTooFarFromMark");
    expect(at("0.000111").valid).toBe(true);
    expect(at("0.000110").errors.price).toBe("priceTooFarFromMark");
  });

  it("holds the band on a market priced in whole units with a whole tick", () => {
    const market = { ...PERP_MARKET, tickSize: "5.000000", lotSize: "1.000000" };
    const mark = { price: "2000.000000", time: NOW };
    const at = (price: string) => validateOrder({ price, size: "1" }, market, mark, NOW);
    expect(at("2200").valid).toBe(true);
    expect(at("2205").errors.price).toBe("priceTooFarFromMark");
  });
});

describe("markMovedMaterially", () => {
  it("tolerates a move within the review tolerance and flags one beyond it", () => {
    expect(MAX_REVIEW_MARK_MOVE_BPS).toBe(50);
    expect(markMovedMaterially("150.000000", "150.750000")).toBe(false);
    expect(markMovedMaterially("150.000000", "150.760000")).toBe(true);
    expect(markMovedMaterially("150.000000", "149.250000")).toBe(false);
    expect(markMovedMaterially("150.000000", "149.240000")).toBe(true);
  });

  it("counts an unreadable or missing live mark as moved", () => {
    expect(markMovedMaterially("150.000000", undefined)).toBe(true);
    expect(markMovedMaterially("150.000000", "abc")).toBe(true);
    expect(markMovedMaterially("0", "150")).toBe(true);
  });
});

describe("describeFieldError", () => {
  it("never surfaces a raw validation code", () => {
    expect(describeFieldError("quantityRequired", PERP_MARKET)).toBe("Enter a quantity in NSOL.");
    expect(describeFieldError("priceRequired", PERP_MARKET)).toBe("Enter a price in nUSD.");
    expect(describeFieldError("quantityNotMultipleOfLot", PERP_MARKET)).toContain("0.100000");
  });
});

describe("describeRejectReason", () => {
  it("translates a known venue reason to plain language", () => {
    expect(describeRejectReason("insufficient margin")).toContain("insufficient margin");
    expect(describeRejectReason("would cross the book")).toContain("cannot cross the book");
  });

  it("still reads as a rejection for an unrecognised reason, verbatim", () => {
    expect(describeRejectReason("a brand new reason")).toBe(
      "Venue rejected this order: a brand new reason. No fill occurred.",
    );
  });
});
