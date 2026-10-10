import { describe, expect, it } from "vitest";
import { orderFunds } from "@/lib/trading/sizing";
import { toFixedPoint } from "@/lib/trading/decimal";

const SPOT = { mode: "spot", price: "100", maxLeverage: 1 } as const;
const PERP = { mode: "perp", price: "100", maxLeverage: 10 } as const;

describe("orderFunds", () => {
  it("covers a spot buy when quote pays for the notional and fee", () => {
    const funds = orderFunds({ ...SPOT, side: "buy", quantity: "2", availableQuote: "201" });
    expect(funds.shortfall).toBeNull();
    expect(funds.requiredQuote).toBe(toFixedPoint("200.1"));
  });

  it("refuses a spot buy when quote falls short, whatever base is held", () => {
    const funds = orderFunds({
      ...SPOT,
      side: "buy",
      quantity: "2",
      availableQuote: "200",
      availableBase: "50",
    });
    expect(funds.shortfall).toEqual({ asset: "quote", needed: "200.100000", available: "200" });
  });

  it("covers a spot sell from the base balance alone, with no quote at all", () => {
    const funds = orderFunds({
      ...SPOT,
      side: "sell",
      quantity: "6.222",
      availableQuote: "0",
      availableBase: "6.222",
    });
    expect(funds.shortfall).toBeNull();
    expect(funds.requiredQuote).toBe(0n);
  });

  it("refuses a spot sell larger than the base balance, whatever quote is held", () => {
    const funds = orderFunds({
      ...SPOT,
      side: "sell",
      quantity: "6.223",
      availableQuote: "100000",
      availableBase: "6.222",
    });
    expect(funds.shortfall).toEqual({ asset: "base", needed: "6.223", available: "6.222" });
  });

  it("refuses a spot sell when no base balance is known", () => {
    const funds = orderFunds({ ...SPOT, side: "sell", quantity: "1", availableQuote: "500" });
    expect(funds.shortfall?.asset).toBe("base");
  });

  it("covers a perp long when quote pays for margin at the market's ratio and the fee", () => {
    const funds = orderFunds({ ...PERP, side: "buy", quantity: "10", availableQuote: "100.5" });
    expect(funds.shortfall).toBeNull();
    expect(funds.requiredQuote).toBe(toFixedPoint("100.5"));
  });

  it("refuses a perp long when quote falls short of margin and fee", () => {
    const funds = orderFunds({ ...PERP, side: "buy", quantity: "10", availableQuote: "100.4" });
    expect(funds.shortfall).toEqual({ asset: "quote", needed: "100.500000", available: "100.4" });
  });

  it("covers a perp short from quote, never from a base balance", () => {
    const funds = orderFunds({ ...PERP, side: "sell", quantity: "10", availableQuote: "100.5" });
    expect(funds.shortfall).toBeNull();
  });

  it("refuses a perp short when quote falls short, whatever base is held", () => {
    const funds = orderFunds({
      ...PERP,
      side: "sell",
      quantity: "10",
      availableQuote: "50",
      availableBase: "1000",
    });
    expect(funds.shortfall?.asset).toBe("quote");
  });
});
