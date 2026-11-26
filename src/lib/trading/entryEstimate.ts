import type { MarketInfo } from "@/lib/market-data/types";
import { withoutSign } from "./decimal";
import { displayOrderCost, estimateOrderCost } from "./risk";
import type { MarketLimits, Position } from "./types";

interface EntryEstimate {
  initialMargin: string;
  liquidationPrice: string | null;
}

/**
 * An open perpetual position's margin and liquidation price at the market's
 * maximum leverage, from its size and entry price alone, once the market
 * account's own ratios are known. Null for a market that is not a perpetual.
 * The exchange does not report the margin actually posted, so this is the
 * closest (most conservative) estimate.
 */
export function positionEntryEstimate(
  position: Position,
  settings: MarketInfo | undefined,
  limits: MarketLimits | undefined,
  priceDecimals: number,
): EntryEstimate | null {
  if (!settings || settings.kind !== "perp") return null;
  const estimate = estimateOrderCost({
    side: Number(position.size) > 0 ? "buy" : "sell",
    quantity: withoutSign(position.size),
    price: position.entryPrice,
    leverage: limits ? 10_000 / limits.imBps : settings.maxLeverage,
    maxLeverage: settings.maxLeverage,
    takerFeeBps: limits?.takerFeeBps,
    maintenanceBps: limits?.mmBps,
  });
  const { initialMargin, liquidationPrice } = displayOrderCost(estimate, priceDecimals);
  return { initialMargin, liquidationPrice };
}
