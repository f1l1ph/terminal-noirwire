import { describe, expect, it } from "vitest";
import { summarizeMargin, type PerpExposure } from "@/lib/trading/accountMargin";

const USDC = 1_000_000n;

function exposure(baseLots: bigint, quoteAtoms: bigint, mark: string | null): PerpExposure {
  return {
    baseLots,
    quoteAtoms,
    openBidLots: 0n,
    openAskLots: 0n,
    sizePerLot: 1_000_000n,
    mark,
    maxLeverage: 10,
  };
}

function equityOf(collateral: bigint, position: PerpExposure): bigint {
  const summary = summarizeMargin(collateral, [position]);
  if (summary.kind !== "known") throw new Error("expected a known summary");
  return summary.equity;
}

describe("summarizeMargin: unrealised P&L from the signed net quote", () => {
  it("charges the loss of a short that was partly bought back higher", () => {
    // Short 10 at 100, then buy back 9 at 200: one lot short, quote 1000 - 1800.
    const position = exposure(-1n, -800n * USDC, "200");
    expect(equityOf(5000n * USDC, position)).toBe(4000n * USDC);
  });

  it("credits a long in profit", () => {
    const position = exposure(10n, -1000n * USDC, "150");
    expect(equityOf(500n * USDC, position)).toBe(1000n * USDC);
  });

  it("charges a long in loss", () => {
    const position = exposure(10n, -1000n * USDC, "80");
    expect(equityOf(500n * USDC, position)).toBe(300n * USDC);
  });

  it("credits a short in profit", () => {
    const position = exposure(-10n, 1000n * USDC, "80");
    expect(equityOf(500n * USDC, position)).toBe(700n * USDC);
  });

  it("values a flipped position by its remaining side, not its history", () => {
    // Long 10 at 100, then sell 15 at 120: five lots short, quote -1000 + 1800.
    const position = exposure(-5n, 800n * USDC, "130");
    expect(equityOf(1000n * USDC, position)).toBe(1150n * USDC);
    expect(equityOf(1000n * USDC, { ...position, mark: "170" })).toBe(950n * USDC);
  });

  it("rounds the marked value toward lower equity for a long and a short", () => {
    const long = exposure(1n, -1n, "0.000001");
    const short = exposure(-1n, 1n, "0.000001");
    expect(equityOf(100n, { ...long, sizePerLot: 1n })).toBe(99n);
    expect(equityOf(100n, { ...short, sizePerLot: 1n })).toBe(100n);
  });

  it("counts no cash flow for a flat slot with only resting orders", () => {
    const resting: PerpExposure = { ...exposure(0n, 500n * USDC, "100"), openBidLots: 1n };
    expect(equityOf(1000n * USDC, resting)).toBe(1000n * USDC);
  });

  it("is unknown when an exposed market has no mark", () => {
    expect(summarizeMargin(1000n * USDC, [exposure(1n, -100n * USDC, null)])).toEqual({
      kind: "unknown",
    });
  });
});

describe("summarizeMargin: the market account's own initial margin", () => {
  it("reserves at the chain's ratio instead of the one implied by max leverage", () => {
    const resting = { ...exposure(0n, 0n, "100"), openBidLots: 10n };
    const implied = summarizeMargin(1000n * USDC, [resting]);
    const chain = summarizeMargin(1000n * USDC, [{ ...resting, imBps: 2500 }]);
    if (implied.kind !== "known" || chain.kind !== "known") throw new Error("expected known");
    expect(implied.reserved).toBe(100n * USDC);
    expect(chain.reserved).toBe(250n * USDC);
  });
});
