import type { CandleInterval } from "@/lib/market-data/types";

/**
 * The chart column's own header: which market. The period and style
 * controls live in the chart itself, so the two never disagree; the
 * interval props are accepted for the existing call site and ignored.
 */
export function MarketHeader({
  marketId,
}: {
  marketId: string | undefined;
  interval?: CandleInterval;
  onIntervalChange?: (interval: CandleInterval) => void;
}) {
  return (
    <div className="flex h-6 items-center px-1">
      <span className="text-dim text-[12px]">
        {marketId === "NSOL-PERP" ? "SOL-PERP" : (marketId ?? "")}
      </span>
    </div>
  );
}
