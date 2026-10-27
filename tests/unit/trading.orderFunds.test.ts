import { describe, expect, it } from "vitest";
import { orderFunds, unknownCollateralBlocks } from "@/lib/trading/sizing";
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

describe("orderFunds against an open position", () => {
  const LONG = { position: "10" };

  it("needs nothing for a reduce-only close, even with almost no balance", () => {
    const funds = orderFunds({
      ...PERP,
      side: "sell",
      quantity: "10",
      availableQuote: "0",
      exposure: LONG,
      reduceOnly: true,
    });
    expect(funds.shortfall).toBeNull();
    expect(funds.requiredQuote).toBe(0n);
    expect(funds.marginQuote).toBe(0n);
  });

  it("lets the small-balance close from the live report through", () => {
    const funds = orderFunds({
      mode: "perp",
      side: "sell",
      quantity: "0.14",
      price: "100",
      maxLeverage: 5,
      availableQuote: "1.19",
      exposure: { position: "0.14" },
      reduceOnly: true,
    });
    expect(funds.shortfall).toBeNull();
  });

  it("asks only for the fee when a plain sell equals the long", () => {
    const funds = orderFunds({
      ...PERP,
      side: "sell",
      quantity: "10",
      availableQuote: "0.5",
      exposure: LONG,
    });
    expect(funds.shortfall).toBeNull();
    expect(funds.marginQuote).toBe(0n);
    expect(funds.requiredQuote).toBe(toFixedPoint("0.5"));
  });

  it("needs no margin when a sell flips the long to a short of the same size", () => {
    const funds = orderFunds({
      ...PERP,
      side: "sell",
      quantity: "20",
      availableQuote: "1",
      exposure: LONG,
    });
    expect(funds.marginQuote).toBe(0n);
    expect(funds.requiredQuote).toBe(toFixedPoint("1"));
  });

  it("asks for margin only on the growth when a sell goes past the flip", () => {
    const funds = orderFunds({
      ...PERP,
      side: "sell",
      quantity: "30",
      availableQuote: "101.5",
      exposure: LONG,
    });
    expect(funds.marginQuote).toBe(toFixedPoint("100"));
    expect(funds.requiredQuote).toBe(toFixedPoint("101.5"));
    expect(funds.shortfall).toBeNull();
    expect(
      orderFunds({ ...PERP, side: "sell", quantity: "30", availableQuote: "101.4", exposure: LONG })
        .shortfall,
    ).not.toBeNull();
  });

  it("asks for full margin when a buy adds to the long", () => {
    const funds = orderFunds({
      ...PERP,
      side: "buy",
      quantity: "10",
      availableQuote: "100.4",
      exposure: LONG,
    });
    expect(funds.marginQuote).toBe(toFixedPoint("100"));
    expect(funds.shortfall).toEqual({ asset: "quote", needed: "100.500000", available: "100.4" });
  });

  it("counts resting sells against the room a new sell has inside the long", () => {
    const funds = orderFunds({
      ...PERP,
      side: "sell",
      quantity: "20",
      availableQuote: "100.5",
      exposure: { position: "10", openAsks: "5" },
    });
    expect(funds.marginQuote).toBe(toFixedPoint("50"));
  });

  it("counts a resting buy as growth only beyond the worst case already held", () => {
    const funds = orderFunds({
      ...PERP,
      side: "sell",
      quantity: "10",
      availableQuote: "0.5",
      exposure: { position: "10", openBids: "5" },
    });
    expect(funds.marginQuote).toBe(0n);
  });

  it("leaves a buy that closes a short free of margin", () => {
    const funds = orderFunds({
      ...PERP,
      side: "buy",
      quantity: "10",
      availableQuote: "0.5",
      exposure: { position: "-10" },
    });
    expect(funds.marginQuote).toBe(0n);
    expect(funds.shortfall).toBeNull();
  });

  it("lets a perp reduce-only order through an unpriced collateral figure", () => {
    expect(
      unknownCollateralBlocks({ availableUnknown: true, isPerp: true, reduceOnly: true }),
    ).toBe(false);
  });

  it("blocks every other order while the collateral figure is unpriced", () => {
    expect(
      unknownCollateralBlocks({ availableUnknown: true, isPerp: true, reduceOnly: false }),
    ).toBe(true);
    expect(
      unknownCollateralBlocks({ availableUnknown: true, isPerp: false, reduceOnly: true }),
    ).toBe(true);
    expect(
      unknownCollateralBlocks({ availableUnknown: false, isPerp: true, reduceOnly: false }),
    ).toBe(false);
  });

  it("keeps spot unchanged whatever exposure or reduce-only flag is passed", () => {
    const funds = orderFunds({
      ...SPOT,
      side: "buy",
      quantity: "2",
      availableQuote: "200",
      exposure: { position: "5" },
      reduceOnly: true,
    });
    expect(funds.shortfall).toEqual({ asset: "quote", needed: "200.100000", available: "200" });
  });
});
