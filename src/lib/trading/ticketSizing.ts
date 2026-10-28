import {
  BPS_SCALE,
  bpsOfFixedPoint,
  divFixedPoint,
  fromFixedPoint,
  mulFixedPoint,
  toFixedPoint,
} from "./decimal";
import { ASSUMED_TAKER_FEE_BPS, MAINTENANCE_MARGIN_BPS, impliedInitialMarginBps } from "./risk";
import type { Side } from "./types";

const ONE = toFixedPoint("1");
const CENT = toFixedPoint("0.01");

/** The slider's step, so a leverage is always one decimal and survives the trip through a number. */
export const LEVERAGE_STEP = 0.1;

function leverageFixedPoint(leverage: number): bigint {
  return toFixedPoint(Math.max(leverage, 1).toFixed(1));
}

function trimZeros(text: string): string {
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

function floorTo(value: bigint, step: bigint): bigint {
  return value - (value % step);
}

/** A positive decimal the trader typed, or null when it is empty, malformed or not above zero. */
export function parseAmount(text: string): bigint | null {
  try {
    const value = toFixedPoint(text);
    return value > 0n ? value : null;
  } catch {
    return null;
  }
}

/** "3x", "2.5x": a whole multiplier drops its decimal. */
export function leverageLabel(leverage: number): string {
  const rounded = Math.round(leverage * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}x`;
}

/** The market's base token as a trader knows it: the test token's leading N is dropped. */
export function displayBase(base: string): string {
  return base === "NSOL" ? "SOL" : base;
}

/**
 * Position size in base units for the collateral a trader commits: amount x
 * leverage worth of notional at `price`, rounded down to the market's lot
 * step. Empty when the amount, leverage or price is unusable or rounds to less
 * than one lot.
 */
export function sizeFromAmount(params: {
  amount: string;
  leverage: number;
  price: string;
  lotSize: string;
}): string {
  try {
    const amount = parseAmount(params.amount);
    const price = toFixedPoint(params.price);
    const lot = toFixedPoint(params.lotSize);
    if (amount === null || price <= 0n) return "";
    const quantity = divFixedPoint(
      mulFixedPoint(amount, leverageFixedPoint(params.leverage)),
      price,
    );
    const rounded = lot > 0n ? floorTo(quantity, lot) : quantity;
    return rounded > 0n ? trimZeros(fromFixedPoint(rounded, 9)) : "";
  } catch {
    return "";
  }
}

/**
 * How much more an order on `side` may add before the market's position limit
 * stops it, in base units. The program counts the position on that side (a long
 * does not offset a sell), the resting orders on that side and the new order
 * together against the limit, so a resting order narrows what a market order
 * may add. Never negative.
 */
export function positionRoom(params: {
  side: Side;
  /** Signed position size: positive long, negative short. */
  position: string;
  openBids?: string;
  openAsks?: string;
  positionCap: string;
}): string {
  const position = toFixedPoint(params.position);
  const onSide =
    params.side === "buy" ? (position > 0n ? position : 0n) : position < 0n ? -position : 0n;
  const resting = toFixedPoint((params.side === "buy" ? params.openBids : params.openAsks) ?? "0");
  const room = toFixedPoint(params.positionCap) - onSide - resting;
  return fromFixedPoint(room > 0n ? room : 0n, 9);
}

/**
 * The largest amount (to the cent) that can be committed at this leverage
 * without the fee and the market's fixed initial margin on its notional
 * exceeding what is available. The margin is reserved on the order's worst-case
 * price (`boundPrice`), so a notional sized at `refPrice` is scaled up by that
 * ratio. Never more than is available.
 */
export function maxAmount(params: {
  available: string;
  leverage: number;
  maxLeverage: number;
  boundPrice: string;
  refPrice: string;
  takerFeeBps?: number;
  /** The market account's initial margin ratio in basis points; implied by `maxLeverage` when absent. */
  imBps?: number;
  /** The most size, in base units, the market's position limit still lets this order add (`positionRoom`); absent when the limit is not known. */
  sizeRoom?: string;
}): string {
  try {
    const available = toFixedPoint(params.available);
    const refPrice = toFixedPoint(params.refPrice);
    const boundPrice = toFixedPoint(params.boundPrice);
    const marginBps =
      params.maxLeverage > 0 ? (params.imBps ?? impliedInitialMarginBps(params.maxLeverage)) : null;
    if (available <= 0n || refPrice <= 0n || boundPrice <= 0n) return "0.00";
    const rateBps =
      BigInt(marginBps ?? 10_000) + BigInt(params.takerFeeBps ?? ASSUMED_TAKER_FEE_BPS);
    const maxNotional = (available * BPS_SCALE) / rateBps;
    const ratio = divFixedPoint(boundPrice, refPrice);
    const notionalAtRef = divFixedPoint(maxNotional, ratio > ONE ? ratio : ONE);
    const byLeverage = divFixedPoint(notionalAtRef, leverageFixedPoint(params.leverage));
    const capped = byLeverage < available ? byLeverage : available;
    const byRoom =
      params.sizeRoom === undefined
        ? capped
        : divFixedPoint(
            mulFixedPoint(toFixedPoint(params.sizeRoom), refPrice),
            leverageFixedPoint(params.leverage),
          );
    return fromFixedPoint(floorTo(byRoom < capped ? byRoom : capped, CENT), 2);
  } catch {
    return "0.00";
  }
}

/** A spot sell has no margin: the most it can commit is the base balance at the reference price, to the cent. */
export function maxSpotSellAmount(availableBase: string, refPrice: string): string {
  try {
    const value = mulFixedPoint(toFixedPoint(availableBase), toFixedPoint(refPrice));
    return fromFixedPoint(floorTo(value, CENT), 2);
  } catch {
    return "0.00";
  }
}

/** A share of `max`, floored to the cent so it can never exceed it; 100 is `max` itself. */
export function amountForPercent(max: string, percent: number): string {
  try {
    const maxFp = toFixedPoint(max);
    if (maxFp <= 0n) return "";
    if (percent >= 100) return fromFixedPoint(maxFp, 2);
    const share = floorTo((maxFp * BigInt(Math.round(percent))) / 100n, CENT);
    return share > 0n ? fromFixedPoint(share, 2) : "";
  } catch {
    return "";
  }
}

export type LiquidationEstimate = { kind: "price"; price: string } | { kind: "none" };

/**
 * Where the account is liquidated if this order were its only position,
 * under cross margin: the account's available collateral less the entry fee
 * backs the position until its equity falls to the maintenance ratio of its
 * value. Null for a zero size or unusable inputs. "none" when the collateral
 * covers the whole notional of a long, so the price would have to reach zero.
 */
export function estimateLiquidation(params: {
  side: Side;
  quantity: string;
  entryPrice: string;
  collateral: string;
  takerFeeBps?: number;
  maintenanceBps?: number;
  priceDecimals: number;
}): LiquidationEstimate | null {
  try {
    const quantity = toFixedPoint(params.quantity);
    const entry = toFixedPoint(params.entryPrice);
    if (quantity <= 0n || entry <= 0n) return null;
    const notional = mulFixedPoint(quantity, entry);
    if (notional <= 0n) return null;
    const fee = bpsOfFixedPoint(notional, params.takerFeeBps ?? ASSUMED_TAKER_FEE_BPS);
    const equity = toFixedPoint(params.collateral) - fee;
    if (equity <= 0n) return null;
    const maintenance = bpsOfFixedPoint(ONE, params.maintenanceBps ?? MAINTENANCE_MARGIN_BPS);
    if (params.side === "buy") {
      if (equity >= notional) return { kind: "none" };
      const ratio = divFixedPoint(notional - equity, mulFixedPoint(notional, ONE - maintenance));
      return {
        kind: "price",
        price: fromFixedPoint(mulFixedPoint(entry, ratio), params.priceDecimals),
      };
    }
    const ratio = divFixedPoint(equity + notional, mulFixedPoint(notional, ONE + maintenance));
    return {
      kind: "price",
      price: fromFixedPoint(mulFixedPoint(entry, ratio), params.priceDecimals),
    };
  } catch {
    return null;
  }
}
