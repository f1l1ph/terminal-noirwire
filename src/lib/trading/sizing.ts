import { QUOTE_DECIMALS } from "../rollup/markets";
import { divFixedPoint, FIXED_POINT_SCALE, fromFixedPoint, toFixedPoint } from "./decimal";
import { ASSUMED_TAKER_FEE_BPS, estimateOrderCost, impliedInitialMarginBps } from "./risk";
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
  /** Initial margin the order adds, fixed-point: zero when it does not grow the worst-case exposure. Perp only. */
  marginQuote: bigint;
  /** A reduce-only order that still raises the worst-case size, so the free balance matters to it. */
  reduceOnlyGrows: boolean;
  shortfall: FundsShortfall | null;
}

/** The trader's exposure on the order's market, in base units. */
export interface MarketExposure {
  /** Signed position size: positive long, negative short. */
  position: string;
  /** Total remaining size of resting buy orders. */
  openBids?: string;
  /** Total remaining size of resting sell orders. */
  openAsks?: string;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function worstCaseLots(base: bigint, bids: bigint, asks: bigint): bigint {
  const up = abs(base + bids);
  const down = abs(base - asks);
  return up > down ? up : down;
}

/**
 * How much the order grows the market's worst-case size, where worst case is
 * the larger of the position plus every resting buy and the position minus
 * every resting sell, in absolute terms. The order counts as resting in full.
 */
function worstCaseIncrease(side: Side, quantity: bigint, exposure: MarketExposure): bigint {
  const base = toFixedPoint(exposure.position);
  const bids = toFixedPoint(exposure.openBids ?? "0");
  const asks = toFixedPoint(exposure.openAsks ?? "0");
  const before = worstCaseLots(base, bids, asks);
  const after =
    side === "buy"
      ? worstCaseLots(base, bids + quantity, asks)
      : worstCaseLots(base, bids, asks + quantity);
  return after > before ? after - before : 0n;
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
  /** Perp only: the market's mark, which the venue prices margin at. Defaults to `price`. */
  markPrice?: string;
  maxLeverage: number;
  availableQuote: string;
  availableBase?: string;
  /** Perp only: the trader's exposure on this market. Without it the order is treated as opening fresh. */
  exposure?: MarketExposure;
  /** Perp only: capped to the position and charged only if it still raises the worst-case size. */
  reduceOnly?: boolean;
}): OrderFunds {
  if (params.mode === "spot" && params.side === "sell") {
    const available = params.availableBase ?? "0";
    const covered = toFixedPoint(params.quantity) <= toFixedPoint(available);
    return {
      requiredQuote: 0n,
      marginQuote: 0n,
      reduceOnlyGrows: false,
      shortfall: covered ? null : { asset: "base", needed: params.quantity, available },
    };
  }
  if (params.mode === "perp") return perpFunds(params);
  const cost = estimateOrderCost({
    side: params.side,
    quantity: params.quantity,
    price: params.price,
    leverage: params.maxLeverage,
    maxLeverage: params.maxLeverage,
  });
  const requiredQuote = cost.notional + cost.fee;
  return fundsOutcome(requiredQuote, 0n, false, params.availableQuote);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

const BPS = 10_000n;

/** One quote atom at the fixed-point scale: the venue charges fees in whole atoms. */
const QUOTE_ATOM = FIXED_POINT_SCALE / 10n ** BigInt(QUOTE_DECIMALS);

function ceilToQuoteAtom(amount: bigint): bigint {
  return ceilDiv(amount, QUOTE_ATOM) * QUOTE_ATOM;
}

/**
 * A perp order the way the venue judges it. A resting order counts in full as
 * a bid or ask. A reduce-only order is capped to the position and judged as
 * filled in full, and asks for funds only if that raises the worst-case size
 * (resting orders on its side can). Margin is priced at the mark, the fee at
 * the order price, and both round up so the form is never looser.
 */
function perpFunds(params: {
  side: Side;
  quantity: string;
  price: string;
  markPrice?: string;
  maxLeverage: number;
  availableQuote: string;
  exposure?: MarketExposure;
  reduceOnly?: boolean;
}): OrderFunds {
  const exposure = params.exposure ?? { position: "0" };
  const base = toFixedPoint(exposure.position);
  const bids = toFixedPoint(exposure.openBids ?? "0");
  const asks = toFixedPoint(exposure.openAsks ?? "0");
  let quantity = toFixedPoint(params.quantity);
  let grown: bigint;
  if (params.reduceOnly) {
    const room = abs(base);
    if (quantity > room) quantity = room;
    const filled = params.side === "buy" ? base + quantity : base - quantity;
    const before = worstCaseLots(base, bids, asks);
    const after = worstCaseLots(filled, bids, asks);
    grown = after > before ? after - before : 0n;
    if (grown === 0n) return fundsOutcome(0n, 0n, false, params.availableQuote);
  } else {
    grown = worstCaseIncrease(params.side, quantity, exposure);
  }
  const price = toFixedPoint(params.price);
  const mark = toFixedPoint(params.markPrice ?? params.price);
  const marginBps = BigInt(impliedInitialMarginBps(params.maxLeverage) ?? 10_000);
  const marginQuote = ceilDiv(grown * mark * marginBps, FIXED_POINT_SCALE * BPS);
  const notional = ceilDiv(quantity * price, FIXED_POINT_SCALE);
  const fee = ceilToQuoteAtom(ceilDiv(notional * BigInt(ASSUMED_TAKER_FEE_BPS), BPS));
  return fundsOutcome(
    fee + marginQuote,
    marginQuote,
    params.reduceOnly === true,
    params.availableQuote,
  );
}

function fundsOutcome(
  requiredQuote: bigint,
  marginQuote: bigint,
  grows: boolean,
  availableQuote: string,
): OrderFunds {
  const covered = requiredQuote <= toFixedPoint(availableQuote);
  return {
    requiredQuote,
    marginQuote,
    reduceOnlyGrows: grows,
    shortfall: covered
      ? null
      : {
          asset: "quote",
          needed: fromFixedPoint(requiredQuote, 6),
          available: availableQuote,
        },
  };
}

/**
 * Whether an unpriced collateral figure stops the order. A perp reduce-only
 * order that does not raise the worst-case size never looks at the free
 * balance, so it goes ahead; every other order waits for the figure.
 */
export function unknownCollateralBlocks(params: {
  availableUnknown: boolean;
  isPerp: boolean;
  reduceOnly: boolean;
  reduceOnlyGrows?: boolean;
}): boolean {
  return (
    params.availableUnknown && !(params.isPerp && params.reduceOnly && !params.reduceOnlyGrows)
  );
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
