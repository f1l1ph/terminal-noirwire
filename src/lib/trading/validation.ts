import type { MarketInfo } from "../market-data/types";
import { marketDisplayName } from "../market-data/displayName";
import { isStale, STALE_MARK_MS } from "../market-data/selectors";
import { toFixedPoint } from "./decimal";
import type { NewOrderInput } from "./types";

export type OrderFieldError =
  | "quantityRequired"
  | "quantityNotMultipleOfLot"
  | "quantityBelowMinimum"
  | "priceRequired"
  | "priceNotMultipleOfTick"
  | "priceNotPositive"
  | "priceTooFarFromMark"
  | "markUnavailable"
  | "markStale";

/** The furthest a submitted price (limit price or market bound) may sit from the current mark. */
export const MAX_LIMIT_PRICE_DEVIATION_BPS = 1000;

export interface OrderValidationResult {
  valid: boolean;
  errors: Partial<Record<"quantity" | "price", OrderFieldError>>;
}

function isMultipleOf(value: bigint, step: bigint): boolean {
  if (step <= 0n) return true;
  return value % step === 0n;
}

/** How far the live mark may move from the one an order was reviewed at before the review no longer stands. */
export const MAX_REVIEW_MARK_MOVE_BPS = 50;

export interface OrderMark {
  price: string;
  time: number;
}

/** Whether the mark has moved materially from `reviewedPrice`. An unreadable price on either side counts as moved. */
export function markMovedMaterially(reviewedPrice: string, livePrice: string | undefined): boolean {
  try {
    const reviewed = toFixedPoint(reviewedPrice);
    const live = toFixedPoint(livePrice ?? "");
    if (reviewed <= 0n) return true;
    const distance = live > reviewed ? live - reviewed : reviewed - live;
    return distance * 10_000n > reviewed * BigInt(MAX_REVIEW_MARK_MOVE_BPS);
  } catch {
    return true;
  }
}

function priceDeviationError(
  price: bigint,
  mark: OrderMark | null | undefined,
  now: number,
  allowStaleMark: boolean,
): OrderFieldError | null {
  let markPrice: bigint;
  try {
    markPrice = toFixedPoint(mark?.price ?? "");
  } catch {
    return "markUnavailable";
  }
  if (markPrice <= 0n) return "markUnavailable";
  if (!allowStaleMark && isStale(mark?.time, now, STALE_MARK_MS)) return "markStale";
  return distanceError(price, markPrice);
}

function distanceError(price: bigint, mark: bigint): OrderFieldError | null {
  const distance = price > mark ? price - mark : mark - price;
  return distance * 10_000n > mark * BigInt(MAX_LIMIT_PRICE_DEVIATION_BPS)
    ? "priceTooFarFromMark"
    : null;
}

/**
 * Checks an order draft against the market's own settings: lot size (which
 * is also the minimum size sim-noirwire accepts; there is no separate
 * maximum in its wire contract) and tick size. Every order type requires a
 * price (see `NewOrderInput`), so the price check always runs. The price
 * must also sit within MAX_LIMIT_PRICE_DEVIATION_BPS of the mark, for a
 * limit order as much as a market one; without a usable, fresh mark (see
 * STALE_MARK_MS) there is nothing to check it against, so the order is
 * refused. `allowStaleMark` lets a stale mark through (the distance check
 * still runs against it) for an order the venue accepts without a fresh price.
 */
export function validateOrder(
  input: Pick<NewOrderInput, "price" | "size">,
  market: MarketInfo,
  mark: OrderMark | null | undefined,
  now: number,
  allowStaleMark = false,
): OrderValidationResult {
  const errors: OrderValidationResult["errors"] = {};

  const quantityText = input.size?.trim();
  if (!quantityText) {
    errors.quantity = "quantityRequired";
  } else {
    let quantity: bigint;
    try {
      quantity = toFixedPoint(quantityText);
    } catch {
      quantity = -1n;
    }
    const lot = toFixedPoint(market.lotSize);
    if (quantity <= 0n) {
      errors.quantity = "quantityRequired";
    } else if (!isMultipleOf(quantity, lot)) {
      errors.quantity = "quantityNotMultipleOfLot";
    } else if (quantity < lot) {
      errors.quantity = "quantityBelowMinimum";
    }
  }

  const priceText = input.price?.trim();
  if (!priceText) {
    errors.price = "priceRequired";
  } else {
    try {
      const price = toFixedPoint(priceText);
      const tick = toFixedPoint(market.tickSize);
      if (price <= 0n) {
        errors.price = "priceNotPositive";
      } else if (!isMultipleOf(price, tick)) {
        errors.price = "priceNotMultipleOfTick";
      } else {
        const deviation = priceDeviationError(price, mark, now, allowStaleMark);
        if (deviation) errors.price = deviation;
      }
    } catch {
      errors.price = "priceNotMultipleOfTick";
    }
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/** Plain-language text for a field error, per the design review: never a raw validation code. */
export function describeFieldError(error: OrderFieldError, market: MarketInfo): string {
  switch (error) {
    case "quantityRequired":
      return `Enter a quantity in ${market.base}.`;
    case "quantityNotMultipleOfLot":
      return `Use increments of ${market.lotSize} ${market.base}.`;
    case "quantityBelowMinimum":
      return `Minimum order is ${market.lotSize} ${market.base}.`;
    case "priceRequired":
      return `Enter a price in ${market.quote}.`;
    case "priceNotPositive":
      return `Price must be above zero.`;
    case "priceNotMultipleOfTick":
      return `Use increments of ${market.tickSize} ${market.quote}.`;
    case "priceTooFarFromMark":
      return `Price is more than ${MAX_LIMIT_PRICE_DEVIATION_BPS / 100}% away from the current price. Check for a typo.`;
    case "markStale":
      return `The current price of ${marketDisplayName(market.id)} is too old. Wait for a fresh price.`;
    case "markUnavailable":
      return `Waiting for the current price of ${marketDisplayName(market.id)}. Try again in a moment.`;
  }
}

/**
 * Translates a venue rejection reason (sim-noirwire's `MemoryVenue`, exact
 * strings read from its source) into a plain sentence. An unrecognised
 * reason still reads as a rejection, verbatim, rather than silently
 * swallowing new venue wording.
 */
export function describeRejectReason(reason: string): string {
  const known: Record<string, string> = {
    "unknown market": "This market is not available.",
    "trader not open": "This wallet is not open yet. Try again in a moment.",
    "size must be positive": "Quantity must be above zero.",
    "size must be a multiple of the lot size": "Quantity must be a whole number of lots.",
    "market order requires a worst price": "A market order needs a maximum or minimum price.",
    "price must be positive": "Price must be above zero.",
    "price must be a multiple of the tick size": "Price must align to the market's tick size.",
    "insufficient balance": "Venue rejected this order: insufficient balance. No fill occurred.",
    "insufficient margin": "Venue rejected this order: insufficient margin. No fill occurred.",
    "would cross the book":
      "This price would fill immediately; a resting order cannot cross the book.",
    "no price available": "The venue has no mark price for this market yet.",
    "stale price": "The venue's mark price is too old to open new exposure right now.",
    "reduce-only: no position to reduce": "There is no open position for reduce-only to close.",
  };
  return known[reason] ?? `Venue rejected this order: ${reason}. No fill occurred.`;
}
