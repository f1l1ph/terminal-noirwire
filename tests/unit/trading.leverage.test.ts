import { describe, expect, it } from "vitest";
import {
  accountLeverage,
  formatLeverage,
  leverageRatio,
  positionRisks,
} from "@/lib/trading/positionRisk";
import type { Position } from "@/lib/trading/types";

function position(market: string, size: string, quote: string): Position {
  return { market, size, entryPrice: "0", quote, maintenanceMarginBps: 500 };
}

function leverages(
  positions: Position[],
  collateral: string,
  marks: Record<string, string | null>,
) {
  const risks = positionRisks(positions, collateral, (market) => marks[market] ?? null)!;
  const byMarket = new Map(
    [...risks].map(([market, risk]) => [
      market,
      leverageRatio(risk.notionalAtoms, risk.equityAtoms),
    ]),
  );
  return { byMarket, account: accountLeverage(risks) };
}

describe("position leverage", () => {
  it("is 10x for a position worth ten times the equity behind it", () => {
    const { byMarket, account } = leverages([position("A", "10", "-1000")], "100", { A: "100" });
    expect(byMarket.get("A")).toBeCloseTo(10, 6);
    expect(account).toBeCloseTo(10, 6);
  });

  it("uses the size's absolute value for a short and moves with the mark", () => {
    const at100 = leverages([position("A", "-10", "1000")], "100", { A: "100" });
    expect(at100.byMarket.get("A")).toBeCloseTo(10, 6);
    const at90 = leverages([position("A", "-10", "1000")], "100", { A: "90" });
    expect(at90.byMarket.get("A")).toBeCloseTo(4.5, 6);
  });

  it("shares one equity across several positions", () => {
    const { byMarket, account } = leverages(
      [position("A", "10", "-1000"), position("B", "-5", "1000")],
      "500",
      { A: "100", B: "200" },
    );
    expect(byMarket.get("A")).toBeCloseTo(2, 6);
    expect(byMarket.get("B")).toBeCloseTo(2, 6);
    expect(account).toBeCloseTo(4, 6);
  });

  it("is unavailable when equity is zero or negative", () => {
    const zero = leverages([position("A", "10", "-1000")], "0", { A: "100" });
    expect(zero.byMarket.get("A")).toBeNull();
    expect(zero.account).toBeNull();
    const negative = leverages([position("A", "10", "-1000")], "100", { A: "80" });
    expect(negative.byMarket.get("A")).toBeNull();
    expect(negative.account).toBeNull();
  });

  it("is unavailable when any mark is missing", () => {
    const { byMarket, account } = leverages(
      [position("A", "10", "-1000"), position("B", "-5", "1000")],
      "500",
      { A: "100", B: null },
    );
    expect(byMarket.get("A")).toBeNull();
    expect(byMarket.get("B")).toBeNull();
    expect(account).toBeNull();
  });

  it("formats one decimal and a floor for tiny figures", () => {
    expect(formatLeverage(3.24)).toBe("3.2x");
    expect(formatLeverage(10)).toBe("10.0x");
    expect(formatLeverage(0.04)).toBe("<0.1x");
  });
});
