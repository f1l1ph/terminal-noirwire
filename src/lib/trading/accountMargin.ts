import { FIXED_POINT_SCALE, toFixedPoint } from "./decimal";
import { impliedInitialMarginBps } from "./risk";

/** One perp market the account has a position or resting orders in, in quote atoms and lots. */
export interface PerpExposure {
  /** Signed: long positive, short negative. */
  baseLots: bigint;
  /** The position's cost basis in quote atoms; only its magnitude is read. */
  quoteAtoms: bigint;
  openBidLots: bigint;
  openAskLots: bigint;
  /** Sim-scale (1e6) size of one lot. */
  sizePerLot: bigint;
  /** Decimal string; null when no fresh mark is available. */
  mark: string | null;
  maxLeverage: number;
}

export type MarginSummary =
  { kind: "known"; equity: bigint; reserved: bigint; available: bigint } | { kind: "unknown" };

const BPS_SCALE = 10_000n;

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

function markAsFixedPoint(mark: string | null): bigint | null {
  if (mark === null) return null;
  try {
    const fixed = toFixedPoint(mark);
    return fixed > 0n ? fixed : null;
  } catch {
    return null;
  }
}

/**
 * Equity is collateral plus unrealised P&L at the mark; reserved is the
 * initial margin on the worst position the resting orders could build;
 * available is what is left, never below zero. Every figure rounds against
 * the trader. The initial margin ratio is implied by each market's
 * advertised max leverage, so the figures are estimates. A mark that is
 * missing for any exposed market makes the whole summary unknown, because
 * collateral alone would overstate the headroom.
 */
export function summarizeMargin(collateral: bigint, exposures: PerpExposure[]): MarginSummary {
  let unrealised = 0n;
  let reserved = 0n;
  for (const exposure of exposures) {
    const hasExposure =
      exposure.baseLots !== 0n || exposure.openBidLots !== 0n || exposure.openAskLots !== 0n;
    if (!hasExposure) continue;
    const mark = markAsFixedPoint(exposure.mark);
    const imBps = impliedInitialMarginBps(exposure.maxLeverage);
    if (mark === null || imBps === null) return { kind: "unknown" };

    const valueOf = (lots: bigint, rounding: (n: bigint, d: bigint) => bigint) =>
      rounding(lots * exposure.sizePerLot * mark, FIXED_POINT_SCALE);

    if (exposure.baseLots > 0n) {
      unrealised += valueOf(exposure.baseLots, floorDiv) - abs(exposure.quoteAtoms);
    } else if (exposure.baseLots < 0n) {
      unrealised += abs(exposure.quoteAtoms) - valueOf(abs(exposure.baseLots), ceilDiv);
    }

    const worstLots = [
      abs(exposure.baseLots + exposure.openBidLots),
      abs(exposure.baseLots - exposure.openAskLots),
    ].reduce((a, b) => (a > b ? a : b));
    reserved += ceilDiv(
      worstLots * exposure.sizePerLot * mark * BigInt(imBps),
      FIXED_POINT_SCALE * BPS_SCALE,
    );
  }
  const equity = collateral + unrealised;
  const free = equity - reserved;
  return { kind: "known", equity, reserved, available: free > 0n ? free : 0n };
}
