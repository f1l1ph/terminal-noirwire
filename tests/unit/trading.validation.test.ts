import { describe, expect, it } from "vitest";
import {
  describeFieldError,
  describeRejectReason,
  MAX_LIMIT_PRICE_DEVIATION_BPS,
  validateOrder,
} from "@/lib/trading/validation";
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

const MARK = "150.000000";

describe("validateOrder: quantity", () => {
  it("accepts a quantity that is a multiple of the lot size", () => {
    const result = validateOrder({ price: "150.00", size: "1.0" }, PERP_MARKET, MARK);
    expect(result.errors.quantity).toBeUndefined();
  });

  it("rejects a quantity that is not a multiple of the lot size", () => {
    const result = validateOrder({ price: "150.00", size: "1.05" }, PERP_MARKET, MARK);
    expect(result.errors.quantity).toBe("quantityNotMultipleOfLot");
  });

  it("rejects a quantity below the market's lot size (the minimum)", () => {
    const result = validateOrder(
      { price: "150.00", size: "0.05" },
      { ...PERP_MARKET, lotSize: "0.100000" },
      MARK,
    );
    expect(result.errors.quantity).toBe("quantityNotMultipleOfLot");
  });

  it("rejects a blank quantity", () => {
    const result = validateOrder({ price: "150.00", size: "" }, PERP_MARKET, MARK);
    expect(result.errors.quantity).toBe("quantityRequired");
    expect(result.valid).toBe(false);
  });
});

describe("validateOrder: price", () => {
  it("rejects a price that is not a multiple of the tick size", () => {
    const result = validateOrder({ price: "150.005", size: "1.0" }, PERP_MARKET, MARK);
    expect(result.errors.price).toBe("priceNotMultipleOfTick");
  });

  it("requires a price for every order type (the venue has no unprotected market order)", () => {
    const result = validateOrder({ price: "", size: "1.0" }, PERP_MARKET, MARK);
    expect(result.errors.price).toBe("priceRequired");
  });

  it("rejects a non-positive price", () => {
    const result = validateOrder({ price: "0", size: "1.0" }, PERP_MARKET, MARK);
    expect(result.errors.price).toBe("priceNotPositive");
  });

  it("accepts a valid price and quantity together", () => {
    const result = validateOrder({ price: "150.00", size: "1.0" }, PERP_MARKET, MARK);
    expect(result.valid).toBe(true);
  });
});

describe("validateOrder: price band around the mark", () => {
  it("allows a price exactly at the maximum deviation, above and below", () => {
    expect(MAX_LIMIT_PRICE_DEVIATION_BPS).toBe(1000);
    expect(validateOrder({ price: "165.00", size: "1.0" }, PERP_MARKET, MARK).valid).toBe(true);
    expect(validateOrder({ price: "135.00", size: "1.0" }, PERP_MARKET, MARK).valid).toBe(true);
  });

  it("refuses a price one tick beyond the maximum deviation", () => {
    const above = validateOrder({ price: "165.01", size: "1.0" }, PERP_MARKET, MARK);
    expect(above.errors.price).toBe("priceTooFarFromMark");
    const below = validateOrder({ price: "134.99", size: "1.0" }, PERP_MARKET, MARK);
    expect(below.errors.price).toBe("priceTooFarFromMark");
  });

  it("refuses a 10x typo on a market-order bound", () => {
    const result = validateOrder({ price: "1515.00", size: "1.0" }, PERP_MARKET, MARK);
    expect(result.valid).toBe(false);
    expect(result.errors.price).toBe("priceTooFarFromMark");
  });

  it("keeps the default 1% market bound valid", () => {
    expect(validateOrder({ price: "151.50", size: "1.0" }, PERP_MARKET, MARK).valid).toBe(true);
  });

  it("refuses any order when there is no usable mark to check against", () => {
    for (const mark of [null, undefined, "", "0", "abc"]) {
      const result = validateOrder({ price: "150.00", size: "1.0" }, PERP_MARKET, mark);
      expect(result.errors.price).toBe("markUnavailable");
    }
  });

  it("explains both errors in plain language", () => {
    expect(describeFieldError("priceTooFarFromMark", PERP_MARKET)).toContain("10%");
    expect(describeFieldError("markUnavailable", PERP_MARKET)).toContain("NSOL-PERP");
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
