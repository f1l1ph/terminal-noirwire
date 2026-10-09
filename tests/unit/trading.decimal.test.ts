import { describe, expect, it } from "vitest";
import { divFixedPoint, fromFixedPoint, mulFixedPoint, toFixedPoint } from "@/lib/trading/decimal";

describe("fixed-point decimal conversion", () => {
  it("round-trips a plain decimal", () => {
    expect(fromFixedPoint(toFixedPoint("150.25"), 2)).toBe("150.25");
  });

  it("round-trips a negative decimal", () => {
    expect(fromFixedPoint(toFixedPoint("-12.5"), 2)).toBe("-12.50");
  });

  it("rejects a non-decimal string", () => {
    expect(() => toFixedPoint("abc")).toThrow();
  });

  it("multiplies two fixed-point values as integers", () => {
    const quantity = toFixedPoint("2");
    const price = toFixedPoint("150.5");
    expect(fromFixedPoint(mulFixedPoint(quantity, price), 2)).toBe("301.00");
  });

  it("divides two fixed-point values as integers", () => {
    const notional = toFixedPoint("1000");
    const leverage = toFixedPoint("5");
    expect(fromFixedPoint(divFixedPoint(notional, leverage), 2)).toBe("200.00");
  });
});
