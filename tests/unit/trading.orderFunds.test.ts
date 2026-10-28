import { describe, expect, it } from "vitest";
import {
  keptSettingsBlock,
  orderFunds,
  staleMarkBlocks,
  unknownCollateralBlocks,
} from "@/lib/trading/sizing";
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

  it("prices a reduce-only close that does not grow exposure at zero, whatever the mark", () => {
    const close = {
      ...PERP,
      side: "sell",
      quantity: "10",
      price: "99",
      availableQuote: "0",
      reduceOnly: true,
      exposure: { position: "10" },
    } as const;
    for (const markPrice of ["100", "1", "100000"]) {
      const funds = orderFunds({ ...close, markPrice });
      expect(funds.requiredQuote).toBe(0n);
      expect(funds.reduceOnlyGrows).toBe(false);
      expect(funds.shortfall).toBeNull();
    }
  });

  it("lets a stale mark through only for a perp reduce-only order that does not grow", () => {
    const stale = { markStale: true, isPerp: true, reduceOnly: true, reduceOnlyGrows: false };
    expect(staleMarkBlocks(stale)).toBe(false);
    expect(staleMarkBlocks({ ...stale, reduceOnlyGrows: true })).toBe(true);
    expect(staleMarkBlocks({ ...stale, reduceOnlyGrows: undefined })).toBe(true);
    expect(staleMarkBlocks({ ...stale, reduceOnly: false })).toBe(true);
    expect(staleMarkBlocks({ ...stale, isPerp: false })).toBe(true);
    expect(staleMarkBlocks({ ...stale, markStale: false, reduceOnly: false })).toBe(false);
  });

  it("lets only a perp reduce-only order that cannot grow through on kept market settings", () => {
    const kept = { closingOnly: true, isPerp: true, reduceOnly: true, reduceOnlyGrows: false };
    expect(keptSettingsBlock(kept)).toBe(false);
    expect(keptSettingsBlock({ ...kept, reduceOnlyGrows: true })).toBe(true);
    expect(keptSettingsBlock({ ...kept, reduceOnlyGrows: undefined })).toBe(true);
    expect(keptSettingsBlock({ ...kept, reduceOnly: false })).toBe(true);
    expect(keptSettingsBlock({ ...kept, isPerp: false })).toBe(true);
    expect(keptSettingsBlock({ ...kept, closingOnly: false, reduceOnly: false })).toBe(false);
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

  it("prices margin at the mark and the fee at the order price for a market sell bound below the mark", () => {
    const base = { ...PERP, side: "sell", quantity: "10", price: "99", markPrice: "100" } as const;
    const funds = orderFunds({ ...base, availableQuote: "100.4" });
    expect(funds.marginQuote).toBe(toFixedPoint("100"));
    expect(funds.requiredQuote).toBe(toFixedPoint("100.495"));
    expect(funds.shortfall).not.toBeNull();
    expect(orderFunds({ ...base, availableQuote: "100.495" }).shortfall).toBeNull();
  });

  it("rounds the fee up to a whole quote atom, as the venue charges it", () => {
    const funds = orderFunds({
      ...PERP,
      maxLeverage: 5,
      side: "buy",
      quantity: "0.067",
      price: "150.01",
      markPrice: "150.001",
      availableQuote: "2.015039",
    });
    expect(funds.requiredQuote).toBe(toFixedPoint("2.0100134") + toFixedPoint("0.005026"));
    expect(funds.shortfall).not.toBeNull();
  });

  it("charges a reduce-only close that resting asks would turn into growth", () => {
    const base = {
      ...PERP,
      side: "sell",
      quantity: "0.14",
      exposure: { position: "0.14", openAsks: "0.30" },
      reduceOnly: true,
    } as const;
    const short = orderFunds({ ...base, availableQuote: "1.4" });
    expect(short.reduceOnlyGrows).toBe(true);
    expect(short.marginQuote).toBe(toFixedPoint("1.4"));
    expect(short.requiredQuote).toBe(toFixedPoint("1.407"));
    expect(short.shortfall).not.toBeNull();
    expect(orderFunds({ ...base, availableQuote: "1.407" }).shortfall).toBeNull();
  });

  it("caps a reduce-only order to the position before judging growth", () => {
    const funds = orderFunds({
      ...PERP,
      side: "sell",
      quantity: "50",
      availableQuote: "0",
      exposure: LONG,
      reduceOnly: true,
    });
    expect(funds.shortfall).toBeNull();
    expect(funds.reduceOnlyGrows).toBe(false);
  });

  it("rounds margin and fee up so the form is never looser at the boundary", () => {
    const base = { ...PERP, side: "buy", quantity: "1", price: "33.333333333" } as const;
    expect(orderFunds({ ...base, availableQuote: "3.350000333" }).shortfall).not.toBeNull();
    const exact = orderFunds({ ...base, availableQuote: "3.350000334" });
    expect(exact.requiredQuote).toBe(toFixedPoint("3.333333334") + toFixedPoint("0.016667"));
    expect(exact.shortfall).toBeNull();
  });

  it("blocks a growing reduce-only order on an unpriced collateral figure", () => {
    expect(
      unknownCollateralBlocks({
        availableUnknown: true,
        isPerp: true,
        reduceOnly: true,
        reduceOnlyGrows: true,
      }),
    ).toBe(true);
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

describe("orderFunds with the market account's ratios", () => {
  const order = {
    ...PERP,
    side: "buy",
    quantity: "1",
    availableQuote: "1000",
  } as const;

  it("takes margin at the chain's initial ratio and the fee at its taker fee", () => {
    const assumed = orderFunds(order);
    const chain = orderFunds({ ...order, imBps: 2000, takerFeeBps: 20 });
    expect(assumed.marginQuote).toBe(toFixedPoint("10"));
    expect(chain.marginQuote).toBe(toFixedPoint("20"));
    expect(chain.requiredQuote - chain.marginQuote).toBe(toFixedPoint("0.2"));
    expect(assumed.requiredQuote - assumed.marginQuote).toBe(toFixedPoint("0.05"));
  });

  it("turns away an order the assumed ratio would have let through", () => {
    const tight = { ...order, availableQuote: "15" };
    expect(orderFunds(tight).shortfall).toBeNull();
    expect(orderFunds({ ...tight, imBps: 2000 }).shortfall).not.toBeNull();
  });
});
