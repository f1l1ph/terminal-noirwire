import { describe, expect, it } from "vitest";
import { displayOrderCost, estimateOrderCost } from "@/lib/trading/risk";

describe("estimateOrderCost", () => {
  it("computes notional, fee and initial margin for a leveraged long", () => {
    const estimate = estimateOrderCost({
      side: "buy",
      quantity: "2",
      price: "150",
      leverage: 5,
      takerFeeBps: 10,
    });
    const display = displayOrderCost(estimate, 2);
    expect(display.notional).toBe("300.00");
    expect(display.fee).toBe("0.30");
    expect(display.initialMargin).toBe("60.00");
  });

  it("estimates a liquidation price below entry for a long", () => {
    const estimate = estimateOrderCost({
      side: "buy",
      quantity: "1",
      price: "100",
      leverage: 10,
      takerFeeBps: 10,
    });
    const display = displayOrderCost(estimate, 2);
    expect(Number(display.liquidationPrice)).toBeLessThan(100);
    expect(Number(display.liquidationPrice)).toBeGreaterThan(0);
  });

  it("estimates a liquidation price above entry for a short", () => {
    const estimate = estimateOrderCost({
      side: "sell",
      quantity: "1",
      price: "100",
      leverage: 10,
      takerFeeBps: 10,
    });
    const display = displayOrderCost(estimate, 2);
    expect(Number(display.liquidationPrice)).toBeGreaterThan(100);
  });

  it("widens the buffer to entry as leverage increases", () => {
    const low = estimateOrderCost({
      side: "buy",
      quantity: "1",
      price: "100",
      leverage: 2,
      takerFeeBps: 10,
    });
    const high = estimateOrderCost({
      side: "buy",
      quantity: "1",
      price: "100",
      leverage: 20,
      takerFeeBps: 10,
    });
    const lowLiq = Number(displayOrderCost(low, 2).liquidationPrice);
    const highLiq = Number(displayOrderCost(high, 2).liquidationPrice);
    // Higher leverage means the liquidation price sits closer to the entry price.
    expect(highLiq).toBeGreaterThan(lowLiq);
  });
});
