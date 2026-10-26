import type { OrderType } from "../sim-api/schema";

/** The order kind that goes on the wire: what the trader picked, or immediate-or-cancel in place of a resting limit. */
export type WireOrderType = OrderType | "immediateOrCancel";

/**
 * Whether a "Limit" is sent as immediate-or-cancel. While a market only lets
 * listed makers rest orders, a resting limit from any other seat is refused,
 * so a limit fills now or cancels instead. A reduce-only order is allowed to
 * rest whoever sends it, so it keeps the type the trader chose.
 */
export function limitSentAsIoc(
  type: OrderType,
  makersListed: boolean,
  reduceOnly: boolean | undefined,
): boolean {
  return type === "limit" && makersListed && !reduceOnly;
}

export function wireOrderType(
  type: OrderType,
  makersListed: boolean,
  reduceOnly: boolean | undefined,
): WireOrderType {
  return limitSentAsIoc(type, makersListed, reduceOnly) ? "immediateOrCancel" : type;
}
