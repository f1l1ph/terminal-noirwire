import {
  bpsOfFixedPoint,
  divFixedPoint,
  fromFixedPoint,
  mulFixedPoint,
  toFixedPoint,
} from "./decimal";
import type { Side } from "./types";

/**
 * `GET /v1/markets` does not expose a taker fee, a maintenance margin ratio,
 * or an initial margin ratio (only `maxLeverage`): see
 * sim-noirwire/src/http/routes/markets.ts. These two constants are this
 * terminal's estimate, read from the same repository's engine source
 * (`src/engine/markets.ts`) rather than from the wire contract, so every
 * figure built from them is labelled an estimate, never an authoritative
 * venue number. docs/BUILD-NOTES.md asks sim-noirwire to publish both.
 */
export const ASSUMED_TAKER_FEE_BPS = 5;

/** A market's implied initial margin ratio from its advertised `maxLeverage` (10000 / maxLeverage). Null for a market with no leverage (spot). */
export function impliedInitialMarginBps(maxLeverage: number): number | null {
  if (maxLeverage <= 0) return null;
  return Math.round(10_000 / maxLeverage);
}

/** Estimated as half the implied initial margin, the common convention and, for this service's current markets, the actual value. */
export function impliedMaintenanceMarginBps(maxLeverage: number): number | null {
  const initial = impliedInitialMarginBps(maxLeverage);
  return initial === null ? null : Math.round(initial / 2);
}

export interface OrderCostEstimate {
  notional: bigint;
  fee: bigint;
  initialMargin: bigint;
  /** Null when the market has no leverage concept (spot). */
  liquidationPrice: bigint | null;
}

export interface OrderCostEstimateDisplay {
  notional: string;
  fee: string;
  initialMargin: string;
  liquidationPrice: string | null;
}

/**
 * All-integer (bigint, fixed-point) estimate of notional, fee, initial
 * margin, and an estimated liquidation price for an opening perp order. For
 * a spot order, pass `maxLeverage: 0` and ignore the margin and liquidation
 * fields in the result.
 */
export function estimateOrderCost(params: {
  side: Side;
  quantity: string;
  price: string;
  leverage: number;
  maxLeverage: number;
  takerFeeBps?: number;
}): OrderCostEstimate {
  const quantityFp = toFixedPoint(params.quantity);
  const priceFp = toFixedPoint(params.price);
  const notional = mulFixedPoint(quantityFp, priceFp);
  const fee = bpsOfFixedPoint(notional, params.takerFeeBps ?? ASSUMED_TAKER_FEE_BPS);
  const isPerp = params.maxLeverage > 0;
  const leverageFp = toFixedPoint(String(Math.max(params.leverage, 1)));
  const initialMargin = isPerp ? divFixedPoint(notional, leverageFp) : notional;

  let liquidationPrice: bigint | null = null;
  const maintenanceBps = impliedMaintenanceMarginBps(params.maxLeverage);
  if (isPerp && maintenanceBps !== null && priceFp > 0n) {
    const leverageInverse = divFixedPoint(toFixedPoint("1"), leverageFp);
    const maintenanceRate = bpsOfFixedPoint(toFixedPoint("1"), maintenanceBps);
    const buffer = leverageInverse - maintenanceRate;
    const delta = mulFixedPoint(priceFp, buffer);
    liquidationPrice = params.side === "buy" ? priceFp - delta : priceFp + delta;
    if (liquidationPrice < 0n) liquidationPrice = 0n;
  }

  return { notional, fee, initialMargin, liquidationPrice };
}

export function displayOrderCost(
  estimate: OrderCostEstimate,
  priceDecimals: number,
  moneyDecimals = 2,
): OrderCostEstimateDisplay {
  return {
    notional: fromFixedPoint(estimate.notional, moneyDecimals),
    fee: fromFixedPoint(estimate.fee, moneyDecimals),
    initialMargin: fromFixedPoint(estimate.initialMargin, moneyDecimals),
    liquidationPrice:
      estimate.liquidationPrice === null
        ? null
        : fromFixedPoint(estimate.liquidationPrice, priceDecimals),
  };
}
