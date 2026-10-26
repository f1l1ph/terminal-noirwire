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
    expect(describeFieldError("markUnavailable", PERP_MARKET)).toContain("price of SOL-PERP.");
    expect(describeFieldError("markStale", PERP_MARKET)).toContain("too old");
  });

  it("refuses a limit order priced near a mark that is older than the stale limit", () => {
    const stale = { price: "150.000000", time: NOW - STALE_MARK_MS - 1 };
    const result = check("149.25", stale);
    expect(result.valid).toBe(false);
    expect(result.errors.price).toBe("markStale");
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
