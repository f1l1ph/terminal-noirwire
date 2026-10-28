import { describe, expect, it } from "vitest";
import {
  amountForPercent,
  displayBase,
  estimateLiquidation,
  leverageLabel,
  maxAmount,
  maxSpotSellAmount,
  parseAmount,
  positionRoom,
  sizeFromAmount,
} from "@/lib/trading/ticketSizing";
import { estimateOrderCost } from "@/lib/trading/risk";
import { orderFunds } from "@/lib/trading/sizing";

describe("sizeFromAmount", () => {
  it("is amount x leverage over price, rounded down to the lot step", () => {
    expect(sizeFromAmount({ amount: "100", leverage: 2, price: "150", lotSize: "0.001" })).toBe(
      "1.333",
    );
    expect(sizeFromAmount({ amount: "100", leverage: 1, price: "150", lotSize: "0.1" })).toBe(
      "0.6",
    );
  });

  it("handles fractional leverage steps exactly", () => {
    expect(sizeFromAmount({ amount: "30", leverage: 2.3, price: "100", lotSize: "0.01" })).toBe(
      "0.69",
    );
    expect(sizeFromAmount({ amount: "10", leverage: 0.1 * 3, price: "100", lotSize: "0.01" })).toBe(
      "0.1",
    );
  });

  it("is empty for no amount, a bad amount or less than one lot", () => {
    expect(sizeFromAmount({ amount: "", leverage: 3, price: "150", lotSize: "0.001" })).toBe("");
    expect(sizeFromAmount({ amount: "abc", leverage: 3, price: "150", lotSize: "0.001" })).toBe("");
    expect(sizeFromAmount({ amount: "0", leverage: 3, price: "150", lotSize: "0.001" })).toBe("");
    expect(sizeFromAmount({ amount: "-5", leverage: 3, price: "150", lotSize: "0.001" })).toBe("");
    expect(sizeFromAmount({ amount: "0.1", leverage: 1, price: "150", lotSize: "0.001" })).toBe("");
    expect(sizeFromAmount({ amount: "10", leverage: 1, price: "", lotSize: "0.001" })).toBe("");
  });

  it("never sizes above the committed notional", () => {
    for (const amount of ["7.77", "51.23", "99.99", "1234.56"]) {
      for (const leverage of [1, 1.7, 3.3, 5]) {
        const size = sizeFromAmount({ amount, leverage, price: "151.37", lotSize: "0.001" });
        const notional = Number(size) * 151.37;
        expect(notional).toBeLessThanOrEqual(Number(amount) * leverage + 1e-9);
        expect(notional).toBeGreaterThan(Number(amount) * leverage - 151.37 * 0.001 - 1e-9);
      }
    }
  });
});

describe("maxAmount", () => {
  const base = { maxLeverage: 5, boundPrice: "151.5", refPrice: "150" };

  it("is the whole balance while the margin on it is covered", () => {
    expect(maxAmount({ ...base, available: "100", leverage: 1 })).toBe("100.00");
    expect(maxAmount({ ...base, available: "100", leverage: 4 })).toBe("100.00");
  });

  it("shrinks at high leverage so margin and fee stay covered", () => {
    const five = Number(maxAmount({ ...base, available: "100", leverage: 5 }));
    expect(five).toBeLessThan(100);
    expect(five).toBeGreaterThan(98);
  });

  it("is zero with no funds", () => {
    expect(maxAmount({ ...base, available: "0", leverage: 3 })).toBe("0.00");
    expect(maxAmount({ ...base, available: "", leverage: 3 })).toBe("0.00");
  });

  it("never produces an order the funds check refuses", () => {
    for (const available of ["10", "51.23", "97.41", "2500"]) {
      for (const leverage of [1, 2.5, 4.9, 5]) {
        for (const side of ["buy", "sell"] as const) {
          const max = maxAmount({
            available,
            leverage,
            maxLeverage: 5,
            boundPrice: side === "buy" ? "151.5" : "148.5",
            refPrice: "150",
          });
          const quantity = sizeFromAmount({
            amount: max,
            leverage,
            price: "150",
            lotSize: "0.001",
          });
          expect(quantity).not.toBe("");
          const funds = orderFunds({
            mode: "perp",
            side,
            quantity,
            price: side === "buy" ? "151.50" : "148.50",
            maxLeverage: 5,
            availableQuote: available,
          });
          expect(funds.shortfall).toBeNull();
        }
      }
    }
  });
});

describe("margin and amount agree", () => {
  it("shows margin as a fifth of the notional the amount buys, never above the amount", () => {
    for (const leverage of [1, 2, 3.5, 5]) {
      const quantity = sizeFromAmount({
        amount: "50",
        leverage,
        price: "150",
        lotSize: "0.001",
      });
      const cost = estimateOrderCost({
        side: "buy",
        quantity,
        price: "150",
        leverage: 5,
        maxLeverage: 5,
      });
      expect(cost.initialMargin * 5n).toBe(cost.notional);
      expect(Number(cost.initialMargin) / 1e9).toBeLessThanOrEqual(50);
    }
  });
});

describe("amountForPercent", () => {
  it("takes a share of the maximum, floored to the cent", () => {
    expect(amountForPercent("100.00", 25)).toBe("25.00");
    expect(amountForPercent("33.33", 50)).toBe("16.66");
    expect(amountForPercent("33.33", 100)).toBe("33.33");
  });

  it("is empty with no funds rather than zero", () => {
    expect(amountForPercent("0.00", 25)).toBe("");
    expect(amountForPercent("0.00", 100)).toBe("");
    expect(amountForPercent("", 50)).toBe("");
  });
});

describe("estimateLiquidation", () => {
  const params = { entryPrice: "100", priceDecimals: 2 };

  it("is null for a zero size", () => {
    expect(
      estimateLiquidation({ ...params, side: "buy", quantity: "", collateral: "100" }),
    ).toBeNull();
    expect(
      estimateLiquidation({ ...params, side: "buy", quantity: "0", collateral: "100" }),
    ).toBeNull();
  });

  it("puts a long below entry and a short above it, from the available collateral", () => {
    const long = estimateLiquidation({
      ...params,
      side: "buy",
      quantity: "5",
      collateral: "100",
    });
    const short = estimateLiquidation({
      ...params,
      side: "sell",
      quantity: "5",
      collateral: "100",
    });
    expect(long).toEqual({ kind: "price", price: "84.26" });
    expect(short).toEqual({ kind: "price", price: "114.23" });
  });

  it("moves closer to entry as the size grows against the same collateral", () => {
    const small = estimateLiquidation({ ...params, side: "buy", quantity: "2", collateral: "100" });
    const large = estimateLiquidation({ ...params, side: "buy", quantity: "5", collateral: "100" });
    expect(small).toEqual({ kind: "price", price: "52.68" });
    expect(Number((large as { price: string }).price)).toBeGreaterThan(
      Number((small as { price: string }).price),
    );
  });

  it("has no liquidation price for a long the collateral fully covers", () => {
    expect(
      estimateLiquidation({ ...params, side: "buy", quantity: "0.5", collateral: "100" }),
    ).toEqual({ kind: "none" });
  });

  it("is null when the collateral cannot even pay the fee", () => {
    expect(
      estimateLiquidation({ ...params, side: "buy", quantity: "5", collateral: "0" }),
    ).toBeNull();
  });
});

describe("helpers", () => {
  it("parses only positive decimals", () => {
    expect(parseAmount("12.5")).not.toBeNull();
    expect(parseAmount("0")).toBeNull();
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("1e3")).toBeNull();
  });

  it("labels leverage", () => {
    expect(leverageLabel(3)).toBe("3x");
    expect(leverageLabel(2.5)).toBe("2.5x");
    expect(leverageLabel(1.1 + 1.2)).toBe("2.3x");
  });

  it("names the base token", () => {
    expect(displayBase("NSOL")).toBe("SOL");
    expect(displayBase("SOL")).toBe("SOL");
  });

  it("caps a spot sell at the base balance", () => {
    expect(maxSpotSellAmount("2.5", "100")).toBe("250.00");
    expect(maxSpotSellAmount("0", "100")).toBe("0.00");
  });
});

describe("ticket sizing with the market account's ratios", () => {
  it("sizes the most an account can commit from the chain's margin and fee", () => {
    const common = {
      available: "100",
      leverage: 10,
      maxLeverage: 10,
      boundPrice: "100",
      refPrice: "100",
    };
    expect(maxAmount(common)).toBe("99.50");
    expect(maxAmount({ ...common, imBps: 2000, takerFeeBps: 20 })).toBe("49.50");
  });

  it("puts the estimated liquidation where the chain's maintenance ratio says", () => {
    const base = {
      side: "buy",
      quantity: "1",
      entryPrice: "100",
      collateral: "20",
      priceDecimals: 2,
    } as const;
    const assumed = estimateLiquidation(base);
    const chain = estimateLiquidation({ ...base, maintenanceBps: 1000 });
    expect(assumed).toEqual({ kind: "price", price: "84.26" });
    expect(chain).toEqual({ kind: "price", price: "88.94" });
  });
});

describe("positionRoom", () => {
  const cap = { positionCap: "2.2" };

  it("is the whole limit with no position and no resting orders", () => {
    expect(positionRoom({ ...cap, side: "buy", position: "0" })).toBe("2.200000000");
  });

  it("takes the position on the order's own side off the limit", () => {
    expect(positionRoom({ ...cap, side: "buy", position: "1.5" })).toBe("0.700000000");
    expect(positionRoom({ ...cap, side: "sell", position: "-1.5" })).toBe("0.700000000");
  });

  it("does not let a position on the other side add room, so a sell that flips a long counts in full", () => {
    expect(positionRoom({ ...cap, side: "sell", position: "1.5" })).toBe("2.200000000");
    expect(positionRoom({ ...cap, side: "buy", position: "-1.5" })).toBe("2.200000000");
  });

  it("takes the resting orders on the same side off the limit, and no others", () => {
    const resting = { openBids: "1.5", openAsks: "0.4" };
    expect(positionRoom({ ...cap, ...resting, side: "buy", position: "0" })).toBe("0.700000000");
    expect(positionRoom({ ...cap, ...resting, side: "sell", position: "0" })).toBe("1.800000000");
  });

  it("is zero, never negative, once the limit is reached", () => {
    expect(positionRoom({ ...cap, side: "buy", position: "2.2", openBids: "1" })).toBe(
      "0.000000000",
    );
  });
});

describe("maxAmount with a position limit", () => {
  const params = {
    available: "1000",
    leverage: 5,
    maxLeverage: 5,
    boundPrice: "100",
    refPrice: "100",
    imBps: 2000,
    takerFeeBps: 5,
  };

  it("is held to the size the limit leaves, priced at the reference and spread over the leverage", () => {
    expect(maxAmount({ ...params, sizeRoom: "2.2" })).toBe("44.00");
  });

  it("changes nothing while the limit is further off than the funds", () => {
    expect(maxAmount({ ...params })).toBe(maxAmount({ ...params, sizeRoom: "100" }));
  });

  it("is zero when no room is left", () => {
    expect(maxAmount({ ...params, sizeRoom: "0" })).toBe("0.00");
  });

  it("never gives a size over the room", () => {
    for (const room of ["0.003", "1.337", "2.2", "9.999"]) {
      const amount = maxAmount({ ...params, available: "100000", sizeRoom: room });
      const size = sizeFromAmount({ amount, leverage: 5, price: "100", lotSize: "0.001" });
      expect(Number(size || "0")).toBeLessThanOrEqual(Number(room));
    }
  });
});
