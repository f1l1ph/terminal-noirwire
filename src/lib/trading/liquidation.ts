import { FIXED_POINT_SCALE } from "./decimal";

/**
 * Liquidation price, break-even and P&L of an open perpetual position, from
 * what the account itself holds, worked in the program's own terms: a
 * position's equity is `base * mark + quote` (its slot's signed net quote
 * cash flow), the account's equity adds the collateral, and the account is
 * liquidatable when `equity * 10000 < sum(|base| * mark * mm_bps)` over its
 * positions (RULES 6 and 8; `equity_of` and `below_maintenance` in the order
 * book's engine margin module). Fees and the liquidation penalty are not
 * part of that test. Funding the program has not yet settled into the slot
 * is part of equity there but is not readable here, so every figure is an
 * estimate that ignores it.
 *
 * Sizes and prices are this terminal's fixed-point numbers (1e9); a value in
 * quote atoms is `size * price / 1e12`.
 */
const ATOMS_SCALE = FIXED_POINT_SCALE * 1_000n;
const BPS = 10_000n;

export interface RiskPosition {
  /** Signed size in base units: long positive, short negative. */
  size: bigint;
  /** The slot's signed net quote cash flow in quote atoms. */
  quoteAtoms: bigint;
  /** Price per base unit; null when no fresh mark is known. */
  mark: bigint | null;
  /** The market's own maintenance margin ratio in basis points. */
  maintenanceBps: number;
}

export type LiquidationEstimate =
  /** The mark at which the account falls below maintenance margin. */
  | { kind: "price"; price: bigint }
  /** No price in the position's losing direction can liquidate the account. */
  | { kind: "none" }
  /** The account is below maintenance margin at the current mark. */
  | { kind: "now" }
  | { kind: "unknown" };

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function floorDiv(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  return numerator % denominator !== 0n && numerator < 0n !== denominator < 0n
    ? quotient - 1n
    : quotient;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return -floorDiv(-numerator, denominator);
}

/**
 * The mark of `positions[index]` at which the account's equity equals its
 * maintenance margin, holding every other position at its current mark. A
 * long is liquidated below it, a short above it, and the price is rounded
 * toward the current price so it is never further away than it really is.
 * With one position the answer does not depend on any mark.
 */
export function estimateLiquidation(
  collateralAtoms: bigint,
  positions: RiskPosition[],
  index: number,
): LiquidationEstimate {
  const own = positions[index];
  if (!own || own.size === 0n || own.maintenanceBps <= 0) return { kind: "unknown" };

  let settled = collateralAtoms;
  let othersValue = 0n;
  let othersRequirement = 0n;
  for (const [at, position] of positions.entries()) {
    settled += position.quoteAtoms;
    if (at === index || position.size === 0n) continue;
    if (position.mark === null || position.maintenanceBps <= 0) return { kind: "unknown" };
    othersValue += position.size * position.mark;
    othersRequirement += abs(position.size) * position.mark * BigInt(position.maintenanceBps);
  }

  // 10000 * (cash + size * p) < |size| * p * mm + others, solved for p.
  const cash = settled * ATOMS_SCALE + othersValue;
  const gap = othersRequirement - BPS * cash;
  const mm = BigInt(own.maintenanceBps);
  if (own.size > 0n) {
    const price = ceilDiv(gap, own.size * (BPS - mm));
    if (price <= 0n) return { kind: "none" };
    return own.mark !== null && own.mark < price ? { kind: "now" } : { kind: "price", price };
  }
  const numerator = -gap;
  if (numerator <= 0n) return { kind: "now" };
  const price = floorDiv(numerator, -own.size * (BPS + mm));
  return own.mark !== null && own.mark > price ? { kind: "now" } : { kind: "price", price };
}

/**
 * The price at which the position's own cash flow nets to zero, `-quote /
 * base`. It is the average entry price only while the position has never
 * been reduced and no funding has been settled; reductions and funding
 * settle into `quote` and move it. Null when the position has already paid
 * for itself (the cash flow is on the other side of zero).
 */
export function breakEvenPrice(size: bigint, quoteAtoms: bigint): bigint | null {
  if (size === 0n) return null;
  const price = floorDiv(-quoteAtoms * ATOMS_SCALE, size);
  return price > 0n ? price : null;
}

/**
 * `base * mark + quote` in quote atoms: what the position adds to equity at
 * this mark. It includes profit taken by earlier reductions and funding
 * already settled, and excludes fees and funding not yet settled.
 */
export function positionPnlAtoms(size: bigint, quoteAtoms: bigint, mark: bigint): bigint {
  return floorDiv(size * mark, ATOMS_SCALE) + quoteAtoms;
}
