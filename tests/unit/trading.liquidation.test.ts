import { describe, expect, it } from "vitest";

import { fromFixedPoint, toFixedPoint } from "@/lib/trading/decimal";
import {
  breakEvenPrice,
  estimateLiquidation,
  positionPnlAtoms,
  type RiskPosition,
} from "@/lib/trading/liquidation";
import { positionRisks } from "@/lib/trading/positionRisk";
import type { Position } from "@/lib/trading/types";

const fp = toFixedPoint;

/** The engine's own test: collateral 1,000,000 atoms, 100 lots (one unit each) traded at 100,000 atoms per lot, mm_bps 500. */
const COLLATERAL = 1_000_000n;
const long100: RiskPosition = {
  size: fp("100"),
  quoteAtoms: -10_000_000n,
  mark: fp("0.1"),
  maintenanceBps: 500,
};
const short100: RiskPosition = { ...long100, size: fp("-100"), quoteAtoms: 10_000_000n };

/** `equity * 10000 < sum(|base| * mark * mm_bps)` with every position at its mark, as the engine decides it (margin.rs `below_maintenance`). */
function liquidatable(collateral: bigint, positions: RiskPosition[]): boolean {
  const scale = 1_000_000_000_000n;
  let equity = collateral * scale;
  let required = 0n;
  for (const position of positions) {
    const value = position.size * position.mark!;
    equity += value + position.quoteAtoms * scale;
    required += (value < 0n ? -value : value) * BigInt(position.maintenanceBps);
  }
  return equity * 10_000n < required;
}

function atMark(position: RiskPosition, mark: bigint): RiskPosition {
  return { ...position, mark };
}

describe("estimateLiquidation against the engine's worked examples", () => {
  it("puts a long's liquidation where the engine's test sits just above maintenance", () => {
    const estimate = estimateLiquidation(COLLATERAL, [long100], 0);
    // audit_r4_limits: 94,740 is "just above maintenance", 90,989 is liquidatable.
    expect(estimate).toEqual({ kind: "price", price: fp("0.094736843") });
    expect(liquidatable(COLLATERAL, [atMark(long100, fp("0.09474"))])).toBe(false);
    expect(liquidatable(COLLATERAL, [atMark(long100, fp("0.090989"))])).toBe(true);
  });

  it("puts a short's liquidation where the engine's test sits just above maintenance", () => {
    const estimate = estimateLiquidation(COLLATERAL, [short100], 0);
    // audit_r4_limits: 104,760 is "just above maintenance", 108,908 is liquidatable.
    expect(estimate).toEqual({ kind: "price", price: fp("0.104761904") });
    expect(liquidatable(COLLATERAL, [atMark(short100, fp("0.10476"))])).toBe(false);
    expect(liquidatable(COLLATERAL, [atMark(short100, fp("0.108908"))])).toBe(true);
  });

  it("is exactly the edge of the engine's test, one fixed-point step either side", () => {
    for (const position of [long100, short100]) {
      const estimate = estimateLiquidation(COLLATERAL, [position], 0);
      if (estimate.kind !== "price") throw new Error("expected a price");
      const beyond = position.size > 0n ? estimate.price - 1n : estimate.price + 1n;
      expect(liquidatable(COLLATERAL, [atMark(position, estimate.price)])).toBe(false);
      expect(liquidatable(COLLATERAL, [atMark(position, beyond)])).toBe(true);
    }
  });

  it("uses the market's own maintenance ratio, not a fixed one", () => {
    const at500 = estimateLiquidation(COLLATERAL, [long100], 0);
    const at1000 = estimateLiquidation(COLLATERAL, [{ ...long100, maintenanceBps: 1000 }], 0);
    if (at500.kind !== "price" || at1000.kind !== "price") throw new Error("expected prices");
    expect(at1000.price).toBeGreaterThan(at500.price);
  });

  it("moves with the account's real collateral", () => {
    const thin = estimateLiquidation(1_000_000n, [long100], 0);
    const deep = estimateLiquidation(5_000_000n, [long100], 0);
    if (thin.kind !== "price" || deep.kind !== "price") throw new Error("expected prices");
    expect(deep.price).toBeLessThan(thin.price);
    expect(liquidatable(5_000_000n, [atMark(long100, deep.price)])).toBe(false);
    expect(liquidatable(5_000_000n, [atMark(long100, deep.price - 1n)])).toBe(true);
  });

  it("says none for a long that no fall can liquidate, and now for one already below", () => {
    expect(estimateLiquidation(50_000_000n, [long100], 0)).toEqual({ kind: "none" });
    expect(estimateLiquidation(COLLATERAL, [atMark(long100, fp("0.09"))], 0)).toEqual({
      kind: "now",
    });
    expect(estimateLiquidation(COLLATERAL, [atMark(short100, fp("0.11"))], 0)).toEqual({
      kind: "now",
    });
  });

  it("holds the other positions at their marks when the account is cross-margined", () => {
    const other: RiskPosition = {
      size: fp("-50"),
      quoteAtoms: 2_500_000n,
      mark: fp("0.055"),
      maintenanceBps: 300,
    };
    const positions = [long100, other];
    const estimate = estimateLiquidation(COLLATERAL, positions, 0);
    if (estimate.kind !== "price") throw new Error("expected a price");
    const at = (mark: bigint) => liquidatable(COLLATERAL, [atMark(long100, mark), other]);
    expect(at(estimate.price)).toBe(false);
    expect(at(estimate.price - 1n)).toBe(true);
    const shortEstimate = estimateLiquidation(COLLATERAL, positions, 1);
    if (shortEstimate.kind !== "price") throw new Error("expected a price");
    const atShort = (mark: bigint) => liquidatable(COLLATERAL, [long100, atMark(other, mark)]);
    expect(atShort(shortEstimate.price)).toBe(false);
    expect(atShort(shortEstimate.price + 1n)).toBe(true);
  });

  it("is unknown when another position has no mark or the margin ratio is missing", () => {
    const unpriced: RiskPosition = { ...short100, mark: null };
    expect(estimateLiquidation(COLLATERAL, [long100, unpriced], 0)).toEqual({ kind: "unknown" });
    expect(estimateLiquidation(COLLATERAL, [{ ...long100, maintenanceBps: 0 }], 0)).toEqual({
      kind: "unknown",
    });
  });

  it("does not need the position's own mark for a single position", () => {
    const withoutMark = estimateLiquidation(COLLATERAL, [{ ...long100, mark: null }], 0);
    expect(withoutMark).toEqual(estimateLiquidation(COLLATERAL, [long100], 0));
  });
});

describe("break-even and P&L", () => {
  it("equals the average entry for a position never reduced", () => {
    expect(breakEvenPrice(fp("100"), -10_000_000n)).toBe(fp("0.1"));
    expect(breakEvenPrice(fp("-100"), 10_000_000n)).toBe(fp("0.1"));
  });

  it("differs from the average entry once part was closed at a profit", () => {
    // Bought 100 at 100,000, sold 40 at 110,000: base 60, quote -10,000,000 + 4,400,000.
    const size = fp("60");
    const quote = -5_600_000n;
    expect(fromFixedPoint(breakEvenPrice(size, quote)!, 6)).toBe("0.093333");
    // 60 * 10,000 unrealised plus 40 * 10,000 already taken.
    expect(positionPnlAtoms(size, quote, fp("0.11"))).toBe(1_000_000n);
  });

  it("has no break-even once the position has paid for itself", () => {
    expect(breakEvenPrice(fp("10"), 500_000n)).toBeNull();
    expect(breakEvenPrice(0n, 0n)).toBeNull();
  });

  it("is negative for a position under water", () => {
    expect(positionPnlAtoms(fp("100"), -10_000_000n, fp("0.09"))).toBe(-1_000_000n);
    expect(positionPnlAtoms(fp("-100"), 10_000_000n, fp("0.11"))).toBe(-1_000_000n);
  });
});

describe("positionRisks", () => {
  const position = (over: Partial<Position> = {}): Position => ({
    market: "NSOL-PERP",
    size: "100",
    entryPrice: "0.1",
    quote: "-10",
    maintenanceMarginBps: 500,
    ...over,
  });

  it("reads quote units and returns the three figures", () => {
    const risks = positionRisks([position()], "1", () => "0.11");
    const risk = risks?.get("NSOL-PERP");
    expect(risk?.pnlAtoms).toBe(1_000_000n);
    expect(risk?.breakEven).toBe(fp("0.1"));
    expect(risk?.liquidation).toEqual({ kind: "price", price: fp("0.094736843") });
  });

  it("has no P&L without a fresh mark but still places liquidation", () => {
    const risk = positionRisks([position()], "1", () => null)?.get("NSOL-PERP");
    expect(risk?.pnlAtoms).toBeNull();
    expect(risk?.liquidation.kind).toBe("price");
  });

  it("is null when the account lacks the program's figures", () => {
    expect(positionRisks([position({ quote: undefined })], "1", () => "0.1")).toBeNull();
    expect(
      positionRisks([position({ maintenanceMarginBps: undefined })], "1", () => "0.1"),
    ).toBeNull();
    expect(positionRisks([position()], null, () => "0.1")).toBeNull();
  });
});
