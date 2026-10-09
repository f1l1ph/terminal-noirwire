import { describe, expect, it } from "vitest";
import { needsSpotTransfer } from "@/lib/trading/spotTransfer";

const base = {
  isPerp: false,
  side: "buy" as const,
  hasWallet: true,
  canTransfer: true,
  spotAvailable: 0,
  collateralAvailable: 100,
};

describe("needsSpotTransfer: the 'move funds to spot' decision", () => {
  it("is true for a spot buy with an empty spot balance and funded collateral", () => {
    expect(needsSpotTransfer(base)).toBe(true);
  });

  it("is false once the spot balance already has funds", () => {
    expect(needsSpotTransfer({ ...base, spotAvailable: 5 })).toBe(false);
  });

  it("is false when collateral is also empty: there is nowhere to move funds from", () => {
    expect(needsSpotTransfer({ ...base, collateralAvailable: 0 })).toBe(false);
  });

  it("is false for a perp market: perps draw on collateral directly, not spot", () => {
    expect(needsSpotTransfer({ ...base, isPerp: true })).toBe(false);
  });

  it("is false for a sell: nothing to buy with, so nothing to fund", () => {
    expect(needsSpotTransfer({ ...base, side: "sell" })).toBe(false);
  });

  it("is false without a wallet yet", () => {
    expect(needsSpotTransfer({ ...base, hasWallet: false })).toBe(false);
  });

  it("is false in dev mode (no transfer capability, collateral is undefined there)", () => {
    expect(needsSpotTransfer({ ...base, canTransfer: false, collateralAvailable: null })).toBe(
      false,
    );
  });

  it("is false when collateral is not tracked at all (dev mode's one-balance shape)", () => {
    expect(needsSpotTransfer({ ...base, collateralAvailable: null })).toBe(false);
  });
});
