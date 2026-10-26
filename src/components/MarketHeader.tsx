import { marketDisplayName } from "@/lib/market-data/displayName";

/**
 * The chart column's own header: which market. The period and style
 * controls live in the chart itself, so the two never disagree.
 */
export function MarketHeader({ marketId }: { marketId: string | undefined }) {
  return (
    <div className="flex h-6 items-center px-1">
      <span className="text-dim text-[12px]">{marketDisplayName(marketId ?? "")}</span>
    </div>
  );
}
