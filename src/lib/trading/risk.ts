import {
  bpsOfFixedPoint,
  divFixedPoint,
  fromFixedPoint,
  mulFixedPoint,
  toFixedPoint,
} from "./decimal";
import type { OrderSide } from "./types";

/**
 * The maintenance margin used for the client-side liquidation estimate.
 * There is no documented risk-engine read endpoint in sim-noirwire's design
 * (see docs/BUILD-NOTES.md): this is a plain, fixed maintenance rate against
 * notional, the same shape most perpetual venues publish, not a number the
 * venue itself has confirmed. The estimate is always labelled as such.
 */
export const MAINTENANCE_MARGIN_BPS = 50;

export interface OrderCostEstimate {
  notional: bigint;
  fee: bigint;
  initialMargin: bigint;
  maintenanceMargin: bigint;
  /** Null when there isn't enough information to estimate (e.g. no leverage). */
  liquidationPrice: bigint | null;
}

export interface OrderCostEstimateDisplay {
  notional: string;
  fee: string;
  initialMargin: string;
  maintenanceMargin: string;
  liquidationPrice: string | null;
}

/**
 * All-integer (bigint, fixed-point) estimate of notional, fee, initial and
 * maintenance margin, and an estimated liquidation price for an opening
 * perp order. For a spot order, pass `leverage: 1` and ignore the margin
 * and liquidation fields in the result.
 */
export function estimateOrderCost(params: {
  side: OrderSide;
  quantity: string;
  price: string;
  leverage: number;
  takerFeeBps: number;
}): OrderCostEstimate {
  const quantityFp = toFixedPoint(params.quantity);
  const priceFp = toFixedPoint(params.price);
  const notional = mulFixedPoint(quantityFp, priceFp);
  const fee = bpsOfFixedPoint(notional, params.takerFeeBps);
  const leverageFp = toFixedPoint(String(params.leverage));
  const initialMargin = params.leverage > 0 ? divFixedPoint(notional, leverageFp) : notional;
  const maintenanceMargin = bpsOfFixedPoint(notional, MAINTENANCE_MARGIN_BPS);

  let liquidationPrice: bigint | null = null;
  if (params.leverage > 0 && priceFp > 0n) {
    const leverageInverse = divFixedPoint(toFixedPoint("1"), leverageFp);
    const maintenanceRate = divFixedPoint(maintenanceMargin, notional === 0n ? 1n : notional);
    const buffer = leverageInverse - maintenanceRate;
    const delta = mulFixedPoint(priceFp, buffer);
    liquidationPrice = params.side === "buy" ? priceFp - delta : priceFp + delta;
    if (liquidationPrice < 0n) liquidationPrice = 0n;
  }

  return { notional, fee, initialMargin, maintenanceMargin, liquidationPrice };
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
    maintenanceMargin: fromFixedPoint(estimate.maintenanceMargin, moneyDecimals),
    liquidationPrice:
      estimate.liquidationPrice === null
        ? null
        : fromFixedPoint(estimate.liquidationPrice, priceDecimals),
  };
}
