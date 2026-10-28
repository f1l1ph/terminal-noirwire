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
 * or an initial margin ratio (only `maxLeverage`). The market account on
 * chain does, and those values (`MarketLimits`) are passed to every estimate
 * once the session has read them. These two constants stand in only until
 * then, so any figure built from them is labelled an estimate.
 */
export const ASSUMED_TAKER_FEE_BPS = 5;

/** A market's initial margin ratio implied by its advertised `maxLeverage` (10000 / maxLeverage), used until the market account's own is known. Null for a market with no leverage (spot). */
export function impliedInitialMarginBps(maxLeverage: number): number | null {
  if (maxLeverage <= 0) return null;
  return Math.round(10_000 / maxLeverage);
}

/** Maintenance margin ratio assumed (5%), in basis points, until the market account's own is known. */
export const MAINTENANCE_MARGIN_BPS = 500;

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
  maintenanceBps?: number;
}): OrderCostEstimate {
  const quantityFp = toFixedPoint(params.quantity);
  const priceFp = toFixedPoint(params.price);
  const notional = mulFixedPoint(quantityFp, priceFp);
  const fee = bpsOfFixedPoint(notional, params.takerFeeBps ?? ASSUMED_TAKER_FEE_BPS);
  const isPerp = params.maxLeverage > 0;
  const leverageFp = toFixedPoint(String(Math.max(params.leverage, 1)));
  const initialMargin = isPerp ? divFixedPoint(notional, leverageFp) : notional;

  let liquidationPrice: bigint | null = null;
  if (isPerp && priceFp > 0n) {
    const leverageInverse = divFixedPoint(toFixedPoint("1"), leverageFp);
    const maintenanceRate = bpsOfFixedPoint(
      toFixedPoint("1"),
      params.maintenanceBps ?? MAINTENANCE_MARGIN_BPS,
    );
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
