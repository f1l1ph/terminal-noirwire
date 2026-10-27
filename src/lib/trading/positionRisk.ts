import { toFixedPoint } from "./decimal";
import {
  accountEquityAtoms,
  breakEvenPrice,
  estimateLiquidation,
  positionNotionalAtoms,
  positionPnlAtoms,
  type LiquidationEstimate,
  type RiskPosition,
} from "./liquidation";
import type { Position } from "./types";

/** Quote atoms (6 decimals) from a decimal quote amount. */
function quoteToAtoms(amount: string): bigint {
  return toFixedPoint(amount) / 1_000n;
}

function markOrNull(price: string | null): bigint | null {
  if (price === null) return null;
  try {
    const mark = toFixedPoint(price);
    return mark > 0n ? mark : null;
  } catch {
    return null;
  }
}

export interface PositionRisk {
  /** `base * mark + quote` in quote atoms; null without a fresh mark. */
  pnlAtoms: bigint | null;
  /** Fixed-point price where the position's own cash flow nets to zero; null when it already has. */
  breakEven: bigint | null;
  liquidation: LiquidationEstimate;
  /** `|base| * mark` in quote atoms; null without a fresh mark. */
  notionalAtoms: bigint | null;
  /** The whole account's equity in quote atoms; null while any open position lacks a fresh mark. */
  equityAtoms: bigint | null;
}

/** Notional over equity, or null when either is missing or equity is not positive. */
export function leverageRatio(
  notionalAtoms: bigint | null,
  equityAtoms: bigint | null,
): number | null {
  if (notionalAtoms === null || equityAtoms === null || equityAtoms <= 0n) return null;
  const ratio = Number(notionalAtoms) / Number(equityAtoms);
  return Number.isFinite(ratio) ? ratio : null;
}

/** Leverage of the whole account: every position's notional over the shared equity. */
export function accountLeverage(risks: Map<string, PositionRisk>): number | null {
  let notional = 0n;
  let equity: bigint | null = null;
  for (const risk of risks.values()) {
    if (risk.notionalAtoms === null) return null;
    notional += risk.notionalAtoms;
    equity = risk.equityAtoms;
  }
  return leverageRatio(notional, equity);
}

/** "3.2x" with one decimal, "<0.1x" for tiny figures. */
export function formatLeverage(ratio: number): string {
  return ratio < 0.1 ? "<0.1x" : `${ratio.toFixed(1)}x`;
}

/**
 * Break-even, P&L and liquidation estimate for every open position of one
 * account, or null when the account does not carry what they need (the
 * program's cash flow per position, each market's maintenance margin, the
 * collateral). `markOf` gives a market's fresh mark as a decimal, or null.
 */
export function positionRisks(
  positions: Position[],
  collateral: string | null,
  markOf: (market: string) => string | null,
): Map<string, PositionRisk> | null {
  if (collateral === null) return null;
  const open = positions.filter((position) => Number(position.size) !== 0);
  const inputs: RiskPosition[] = [];
  for (const position of open) {
    if (position.quote === undefined || position.maintenanceMarginBps === undefined) return null;
    inputs.push({
      size: toFixedPoint(position.size),
      quoteAtoms: quoteToAtoms(position.quote),
      mark: markOrNull(markOf(position.market)),
      maintenanceBps: position.maintenanceMarginBps,
    });
  }
  const collateralAtoms = quoteToAtoms(collateral);
  const equityAtoms = accountEquityAtoms(collateralAtoms, inputs);
  const risks = new Map<string, PositionRisk>();
  open.forEach((position, index) => {
    const input = inputs[index]!;
    risks.set(position.market, {
      notionalAtoms: input.mark === null ? null : positionNotionalAtoms(input.size, input.mark),
      equityAtoms,
      pnlAtoms:
        input.mark === null ? null : positionPnlAtoms(input.size, input.quoteAtoms, input.mark),
      breakEven: breakEvenPrice(input.size, input.quoteAtoms),
      liquidation: estimateLiquidation(collateralAtoms, inputs, index),
    });
  });
  return risks;
}
