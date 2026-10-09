import { describe, expect, it } from "vitest";
import { validateOrder } from "@/lib/trading/validation";
import type { MarketInfo } from "@/lib/market-data/types";

const PERP_MARKET: MarketInfo = {
  id: "NSOL-PERP",
  kind: "perp",
  baseSymbol: "NSOL",
  quoteSymbol: "nUSD",
  tickSize: "0.01",
  lotSize: "0.1",
  minSize: "0.1",
  maxSize: "1000",
  maxLeverage: 20,
  priceDecimals: 2,
  sizeDecimals: 1,
  takerFeeBps: 10,
  makerFeeBps: 2,
  markPrice: "150.00",
  markPriceUpdatedAt: 0,
  change24h: 0,
  volume24h: "0",
  openInterest: "0",
  network: "devnet",
  simulated: true,
};

const SPOT_MARKET: MarketInfo = {
  ...PERP_MARKET,
  id: "NSOL-NUSD",
  kind: "spot",
  maxLeverage: 1,
};

describe("validateOrder: quantity", () => {
  it("accepts a quantity that is a multiple of the lot size", () => {
    const result = validateOrder(
      { orderType: "limit", quantity: "1.0", limitPrice: "150.00", leverage: 1 },
      PERP_MARKET,
    );
    expect(result.errors.quantity).toBeUndefined();
  });

  it("rejects a quantity that is not a multiple of the lot size", () => {
    const result = validateOrder(
      { orderType: "limit", quantity: "1.05", limitPrice: "150.00", leverage: 1 },
      PERP_MARKET,
    );
    expect(result.errors.quantity).toBe("quantityNotMultipleOfLot");
  });

  it("rejects a quantity below the market minimum", () => {
    const result = validateOrder(
      { orderType: "limit", quantity: "0.05", limitPrice: "150.00", leverage: 1 },
      { ...PERP_MARKET, lotSize: "0.05" },
    );
    expect(result.errors.quantity).toBe("quantityBelowMinimum");
  });

  it("rejects a quantity above the market maximum", () => {
    const result = validateOrder(
      { orderType: "limit", quantity: "2000", limitPrice: "150.00", leverage: 1 },
      PERP_MARKET,
    );
    expect(result.errors.quantity).toBe("quantityAboveMaximum");
  });

  it("rejects a blank quantity", () => {
    const result = validateOrder(
      { orderType: "limit", quantity: "", limitPrice: "150.00", leverage: 1 },
      PERP_MARKET,
    );
    expect(result.errors.quantity).toBe("quantityRequired");
    expect(result.valid).toBe(false);
  });
});

describe("validateOrder: limit price", () => {
  it("rejects a limit price that is not a multiple of the tick size", () => {
    const result = validateOrder(
      { orderType: "limit", quantity: "1.0", limitPrice: "150.005", leverage: 1 },
      PERP_MARKET,
    );
    expect(result.errors.limitPrice).toBe("limitPriceNotMultipleOfTick");
  });

  it("requires a limit price for a limit order", () => {
    const result = validateOrder({ orderType: "limit", quantity: "1.0", leverage: 1 }, PERP_MARKET);
    expect(result.errors.limitPrice).toBe("limitPriceRequired");
  });

  it("does not require a limit price for a market order", () => {
    const result = validateOrder(
      { orderType: "market", quantity: "1.0", leverage: 1, protectionPrice: "150" },
      PERP_MARKET,
    );
    expect(result.errors.limitPrice).toBeUndefined();
  });
});

describe("validateOrder: spot protection price", () => {
  it("requires a protective execution bound for a spot market order", () => {
    const result = validateOrder({ orderType: "market", quantity: "1.0" }, SPOT_MARKET);
    expect(result.errors.protectionPrice).toBe("protectionPriceRequired");
  });
});

describe("validateOrder: leverage", () => {
  it("rejects leverage above the market's max", () => {
    const result = validateOrder(
      { orderType: "limit", quantity: "1.0", limitPrice: "150.00", leverage: 25 },
      PERP_MARKET,
    );
    expect(result.errors.leverage).toBe("leverageAboveMarketMax");
  });

  it("rejects leverage below one", () => {
    const result = validateOrder(
      { orderType: "limit", quantity: "1.0", limitPrice: "150.00", leverage: 0.5 },
      PERP_MARKET,
    );
    expect(result.errors.leverage).toBe("leverageBelowOne");
  });

  it("does not require leverage on a spot market", () => {
    const result = validateOrder(
      { orderType: "limit", quantity: "1.0", limitPrice: "150.00" },
      SPOT_MARKET,
    );
    expect(result.errors.leverage).toBeUndefined();
  });
});
