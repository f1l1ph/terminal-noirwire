import { divFixedPoint, fromFixedPoint, toFixedPoint } from "./decimal";
import { ASSUMED_TAKER_FEE_BPS, estimateOrderCost } from "./risk";
import type { Side } from "./types";

export interface FundsShortfall {
  /** Which balance falls short: the base asset for a spot sell, the quote asset for everything else. */
  asset: "base" | "quote";
  needed: string;
  available: string;
}

export interface OrderFunds {
  /** Quote the order takes out of the available balance, fixed-point: nothing for a spot sell, which spends the base asset. */
  requiredQuote: bigint;
  shortfall: FundsShortfall | null;
}

/**
 * What an order draws on and whether the account covers it. A spot sell
 * spends the base asset it sells; a spot buy spends quote for the notional
 * and fee; a perp order, either side, needs quote for its fee and margin.
 * The venue takes margin at the market's fixed ratio (`maxLeverage`),
 * whatever leverage the form displays.
 */
export function orderFunds(params: {
  mode: "perp" | "spot";
  side: Side;
  quantity: string;
  price: string;
  maxLeverage: number;
  availableQuote: string;
  availableBase?: string;
}): OrderFunds {
  if (params.mode === "spot" && params.side === "sell") {
    const available = params.availableBase ?? "0";
    const covered = toFixedPoint(params.quantity) <= toFixedPoint(available);
    return {
      requiredQuote: 0n,
      shortfall: covered ? null : { asset: "base", needed: params.quantity, available },
    };
  }
  const cost = estimateOrderCost({
    side: params.side,
    quantity: params.quantity,
    price: params.price,
    leverage: params.maxLeverage,
    maxLeverage: params.maxLeverage,
  });
  const requiredQuote =
    params.mode === "perp" ? cost.fee + cost.initialMargin : cost.notional + cost.fee;
  const covered = requiredQuote <= toFixedPoint(params.availableQuote);
  return {
    requiredQuote,
    shortfall: covered
      ? null
      : {
          asset: "quote",
          needed: fromFixedPoint(requiredQuote, 6),
          available: params.availableQuote,
        },
  };
}

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
