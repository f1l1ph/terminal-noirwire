import type { MarketInfo } from "../market-data/types";
import { toFixedPoint } from "./decimal";
import type { NewOrderInput } from "./types";

export type OrderFieldError =
  | "quantityRequired"
  | "quantityNotMultipleOfLot"
  | "quantityBelowMinimum"
  | "quantityAboveMaximum"
  | "limitPriceRequired"
  | "limitPriceNotMultipleOfTick"
  | "protectionPriceRequired"
  | "leverageRequired"
  | "leverageAboveMarketMax"
  | "leverageBelowOne";

export interface OrderValidationResult {
  valid: boolean;
  errors: Partial<
    Record<"quantity" | "limitPrice" | "protectionPrice" | "leverage", OrderFieldError>
  >;
}

function isMultipleOf(value: bigint, step: bigint): boolean {
  if (step <= 0n) return true;
  return value % step === 0n;
}

function parseOrZero(value: string | undefined): bigint {
  if (!value || value.trim() === "") return 0n;
  try {
    return toFixedPoint(value);
  } catch {
    return 0n;
  }
}

/**
 * Checks an order draft against the market's own settings: tick, lot,
 * minimum and maximum size, and (for perps) the leverage range. A blank or
 * unparsable numeric field fails its own check rather than being treated as
 * zero and passing by accident.
 */
export function validateOrder(
  input: Pick<
    NewOrderInput,
    "orderType" | "quantity" | "limitPrice" | "protectionPrice" | "leverage"
  >,
  market: MarketInfo,
): OrderValidationResult {
  const errors: OrderValidationResult["errors"] = {};

  const quantityText = input.quantity?.trim();
  if (!quantityText) {
    errors.quantity = "quantityRequired";
  } else {
    let quantity: bigint;
    try {
      quantity = toFixedPoint(quantityText);
    } catch {
      errors.quantity = "quantityNotMultipleOfLot";
      quantity = -1n;
    }
    if (!errors.quantity) {
      const lot = parseOrZero(market.lotSize);
      const min = parseOrZero(market.minSize);
      const max = market.maxSize ? parseOrZero(market.maxSize) : null;
      if (quantity <= 0n) {
        errors.quantity = "quantityRequired";
      } else if (!isMultipleOf(quantity, lot)) {
        errors.quantity = "quantityNotMultipleOfLot";
      } else if (quantity < min) {
        errors.quantity = "quantityBelowMinimum";
      } else if (max !== null && quantity > max) {
        errors.quantity = "quantityAboveMaximum";
      }
    }
  }

  if (input.orderType === "limit") {
    const limitText = input.limitPrice?.trim();
    if (!limitText) {
      errors.limitPrice = "limitPriceRequired";
    } else {
      try {
        const limitPrice = toFixedPoint(limitText);
        const tick = parseOrZero(market.tickSize);
        if (limitPrice <= 0n || !isMultipleOf(limitPrice, tick)) {
          errors.limitPrice = "limitPriceNotMultipleOfTick";
        }
      } catch {
        errors.limitPrice = "limitPriceNotMultipleOfTick";
      }
    }
  }

  if (input.orderType === "market" && !input.protectionPrice?.trim()) {
    errors.protectionPrice = "protectionPriceRequired";
  }

  if (market.kind === "perp") {
    if (input.leverage === undefined || !Number.isFinite(input.leverage)) {
      errors.leverage = "leverageRequired";
    } else if (input.leverage < 1) {
      errors.leverage = "leverageBelowOne";
    } else if (input.leverage > market.maxLeverage) {
      errors.leverage = "leverageAboveMarketMax";
    }
  }

  return { valid: Object.keys(errors).length === 0, errors };
}
