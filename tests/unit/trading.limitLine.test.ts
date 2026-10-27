import { describe, expect, it } from "vitest";
import {
  limitLineFor,
  priceAtTick,
  sliderPosition,
  tickSlider,
} from "../../src/lib/trading/limitLine";

describe("limitLineFor", () => {
  it("shows a valid limit price with its side", () => {
    expect(limitLineFor({ orderType: "limit", priceText: "101.5", side: "buy" })).toEqual({
      price: 101.5,
      side: "buy",
    });
    expect(limitLineFor({ orderType: "limit", priceText: " 99 ", side: "sell" })?.side).toBe(
      "sell",
    );
  });

  it("hides for a market order", () => {
    expect(limitLineFor({ orderType: "market", priceText: "101.5", side: "buy" })).toBeNull();
  });

  it.each(["", "   ", "abc", "0", "-5", "Infinity", "1e999"])("hides for price %j", (priceText) => {
    expect(limitLineFor({ orderType: "limit", priceText, side: "buy" })).toBeNull();
  });
});

describe("tickSlider", () => {
  it("spans plus and minus 10 percent of the mark in whole ticks", () => {
    expect(tickSlider(100, 0.5)).toEqual({ min: 180, max: 220 });
    expect(tickSlider(100, 1)).toEqual({ min: 90, max: 110 });
  });

  it("is absent without a usable mark or tick, or a range too narrow to move in", () => {
    expect(tickSlider(NaN, 1)).toBeNull();
    expect(tickSlider(100, 0)).toBeNull();
    expect(tickSlider(100, NaN)).toBeNull();
    expect(tickSlider(100, 50)).toBeNull();
  });

  it("never reaches a zero or negative price", () => {
    expect(tickSlider(1, 0.1)?.min).toBeGreaterThanOrEqual(1);
  });
});

describe("sliderPosition and priceAtTick", () => {
  const slider = { min: 90, max: 110 };

  it("rounds the typed price to the nearest tick", () => {
    expect(sliderPosition("100.4", 100, 1, slider)).toBe(100);
    expect(sliderPosition("100.6", 100, 1, slider)).toBe(101);
  });

  it("clamps a price outside the range", () => {
    expect(sliderPosition("500", 100, 1, slider)).toBe(110);
    expect(sliderPosition("1", 100, 1, slider)).toBe(90);
  });

  it("sits at the mark when the price is empty or invalid", () => {
    expect(sliderPosition("", 100, 1, slider)).toBe(100);
    expect(sliderPosition("x", 100, 1, slider)).toBe(100);
  });

  it("turns a tick index back into a fixed-decimal price without float noise", () => {
    expect(priceAtTick(1003, 0.1, 1)).toBe("100.3");
    expect(priceAtTick(180, 0.5, 2)).toBe("90.00");
  });
});
