import type { MarketInfo } from "../market-data/types";
import { toFixedPoint } from "./decimal";
import type { NewOrderInput } from "./types";

export type OrderFieldError =
  | "quantityRequired"
  | "quantityNotMultipleOfLot"
  | "quantityBelowMinimum"
  | "priceRequired"
  | "priceNotMultipleOfTick"
  | "priceNotPositive";

export interface OrderValidationResult {
  valid: boolean;
  errors: Partial<Record<"quantity" | "price", OrderFieldError>>;
}

function isMultipleOf(value: bigint, step: bigint): boolean {
  if (step <= 0n) return true;
  return value % step === 0n;
}

/**
 * Checks an order draft against the market's own settings: lot size (which
 * is also the minimum size sim-noirwire accepts; there is no separate
 * maximum in its wire contract) and tick size. Every order type requires a
 * price (see `NewOrderInput`), so the price check always runs.
 */
export function validateOrder(
  input: Pick<NewOrderInput, "price" | "size">,
  market: MarketInfo,
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
