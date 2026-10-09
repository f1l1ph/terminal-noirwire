import type { MarketInfo } from "./types";

/** How many fraction digits a decimal string actually carries, trailing zeros stripped (`"0.010000"` -> 2, `"1.000000"` -> 0). */
export function decimalPlaces(value: string): number {
  const dot = value.indexOf(".");
  if (dot === -1) return 0;
  const fraction = value.slice(dot + 1).replace(/0+$/, "");
  return fraction.length;
}

/** sim-noirwire's `/v1/markets` gives tick and lot size but no separate "decimals to display" field; this is derived from them. */
export function priceDecimalsOf(market: Pick<MarketInfo, "tickSize">): number {
  return Math.max(decimalPlaces(market.tickSize), 0);
}

export function sizeDecimalsOf(market: Pick<MarketInfo, "lotSize">): number {
  return Math.max(decimalPlaces(market.lotSize), 0);
}
