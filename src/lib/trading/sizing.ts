import { divFixedPoint, fromFixedPoint, toFixedPoint } from "./decimal";
import { ASSUMED_TAKER_FEE_BPS } from "./risk";
import type { Side } from "./types";

function roundDownToLot(quantityFp: bigint, lotFp: bigint): bigint {
  if (lotFp <= 0n) return quantityFp;
  return quantityFp - (quantityFp % lotFp);
}

/**
 * The largest size this order could use, so the quantity field's
 * percentage shortcuts are pre-blocked rather than producing a value the
 * form would then reject as unaffordable. Reduce-only is capped by the
 * open position instead of free balance (closing never needs margin for
 * the part it closes).
 */
export function maxOrderSize(params: {
  mode: "perp" | "spot";
  side: Side;
  price: string;
  lotSize: string;
  leverage: number;
  takerFeeBps?: number;
  availableQuote: string;
  availableBase?: string;
  reduceOnlyMax?: string;
}): string {
  const lotFp = toFixedPoint(params.lotSize);
  if (params.reduceOnlyMax !== undefined) {
    const capped = roundDownToLot(toFixedPoint(params.reduceOnlyMax), lotFp);
    return fromFixedPoint(capped, 12);
  }

  const priceFp = toFixedPoint(params.price || "0");
  if (priceFp <= 0n) return "0";
  const feeBps = params.takerFeeBps ?? ASSUMED_TAKER_FEE_BPS;

  if (params.mode === "spot" && params.side === "sell") {
    const capped = roundDownToLot(toFixedPoint(params.availableBase ?? "0"), lotFp);
    return fromFixedPoint(capped, 12);
  }

  const availableFp = toFixedPoint(params.availableQuote || "0");
  const leverageFp =
    params.mode === "perp" ? toFixedPoint(String(Math.max(params.leverage, 1))) : toFixedPoint("1");
  // needed = notional * (1/leverage + feeBps/10000); maxNotional = available / that rate.
  const inverseLeverage = divFixedPoint(toFixedPoint("1"), leverageFp);
  const feeRate = divFixedPoint(toFixedPoint(String(feeBps)), toFixedPoint("10000"));
  const rate = inverseLeverage + feeRate;
  if (rate <= 0n) return "0";
  const maxNotional = divFixedPoint(availableFp, rate);
  const maxQuantity = divFixedPoint(maxNotional, priceFp);
  const capped = roundDownToLot(maxQuantity, lotFp);
  return fromFixedPoint(capped < 0n ? 0n : capped, 12);
}
