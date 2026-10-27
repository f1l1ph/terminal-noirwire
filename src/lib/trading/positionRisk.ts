import { toFixedPoint } from "./decimal";
import {
  breakEvenPrice,
  estimateLiquidation,
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
  const risks = new Map<string, PositionRisk>();
  open.forEach((position, index) => {
    const input = inputs[index]!;
    risks.set(position.market, {
      pnlAtoms:
        input.mark === null ? null : positionPnlAtoms(input.size, input.quoteAtoms, input.mark),
      breakEven: breakEvenPrice(input.size, input.quoteAtoms),
      liquidation: estimateLiquidation(collateralAtoms, inputs, index),
    });
  });
  return risks;
}
