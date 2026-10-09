import { describe, expect, it } from "vitest";
import {
  displayOrderCost,
  estimateOrderCost,
  impliedInitialMarginBps,
  impliedMaintenanceMarginBps,
} from "@/lib/trading/risk";

describe("impliedInitialMarginBps / impliedMaintenanceMarginBps", () => {
  it("derives 10% initial and 5% maintenance from 10x max leverage", () => {
    expect(impliedInitialMarginBps(10)).toBe(1000);
    expect(impliedMaintenanceMarginBps(10)).toBe(500);
  });

  it("has no margin concept for a market with no leverage (spot)", () => {
    expect(impliedInitialMarginBps(0)).toBeNull();
    expect(impliedMaintenanceMarginBps(0)).toBeNull();
  });
});

describe("estimateOrderCost", () => {
  it("computes notional, fee and initial margin for a leveraged long", () => {
    const estimate = estimateOrderCost({
      side: "buy",
      quantity: "2",
      price: "150",
      leverage: 5,
      maxLeverage: 10,
    });
    const display = displayOrderCost(estimate, 2);
    expect(display.notional).toBe("300.00");
    expect(display.fee).toBe("0.15");
    expect(display.initialMargin).toBe("60.00");
  });

  it("estimates a liquidation price below entry for a long", () => {
    const estimate = estimateOrderCost({
      side: "buy",
      quantity: "1",
      price: "100",
      leverage: 10,
      maxLeverage: 10,
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
      maxLeverage: 10,
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
      maxLeverage: 10,
    });
    const high = estimateOrderCost({
      side: "buy",
      quantity: "1",
      price: "100",
      leverage: 10,
      maxLeverage: 10,
    });
    const lowLiq = Number(displayOrderCost(low, 2).liquidationPrice);
    const highLiq = Number(displayOrderCost(high, 2).liquidationPrice);
    // Higher leverage means the liquidation price sits closer to the entry price.
    expect(highLiq).toBeGreaterThan(lowLiq);
  });

  it("has no liquidation price for a spot order (no leverage concept)", () => {
    const estimate = estimateOrderCost({
      side: "buy",
      quantity: "1",
      price: "100",
      leverage: 1,
      maxLeverage: 0,
    });
    expect(estimate.liquidationPrice).toBeNull();
  });
});
