import { describe, expect, it } from "vitest";
import { decimalPlaces, priceDecimalsOf, sizeDecimalsOf } from "@/lib/market-data/precision";

describe("decimalPlaces", () => {
  it("strips trailing zeros", () => {
    expect(decimalPlaces("0.010000")).toBe(2);
    expect(decimalPlaces("0.000100")).toBe(4);
    expect(decimalPlaces("1.000000")).toBe(0);
  });

  it("handles a value with no fraction at all", () => {
    expect(decimalPlaces("5")).toBe(0);
  });
});

describe("priceDecimalsOf / sizeDecimalsOf", () => {
  it("reads precision from tick and lot size, sim-noirwire's own wire fields", () => {
    const market = { tickSize: "0.010000", lotSize: "0.001000" };
    expect(priceDecimalsOf(market)).toBe(2);
    expect(sizeDecimalsOf(market)).toBe(3);
  });
});
