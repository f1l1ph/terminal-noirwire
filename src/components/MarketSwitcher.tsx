import { formatDecimal, formatRelativeAge, UNAVAILABLE } from "@/lib/format";
import type { MarketInfo } from "@/lib/market-data/types";
import { ageMs } from "@/lib/market-data/selectors";
import { priceDecimalsOf } from "@/lib/market-data/precision";

function updatedText(age: number): string {
  const relative = formatRelativeAge(age);
  return relative === "just now" ? "Updated just now" : `Updated ${relative} ago`;
}

export function MarketSwitcher({
  markets,
  selectedId,
  selectedMark,
  onSelect,
  now,
}: {
  markets: MarketInfo[];
  selectedId: string;
  /** The mark the price header shows for the selected market, so the list row reads the same price and age. */
  selectedMark: { price: string; time: number } | null;
  onSelect: (id: string) => void;
  now: number;
}) {
  return (
    <nav aria-label="Markets" className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-1.5">
      {markets.map((market) => {
        const selected = market.id === selectedId;
        const price = selected && selectedMark ? selectedMark.price : market.markPrice;
        const updatedAtMs =
          selected && selectedMark ? selectedMark.time : market.markPriceUpdatedAtMs;
        const age = ageMs(updatedAtMs, now);
        const change = market.change24hPercent;
        return (
          <button
            key={market.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(market.id)}
            className={`rounded-tile flex shrink-0 flex-col gap-0.5 px-2 py-1.5 text-left transition-colors ${
              selected ? "bg-elevated text-ink-strong" : "text-dim hover:bg-surface-raised"
            }`}
          >
            <span className="text-[13px] font-medium">{market.id}</span>
            <span className="tnum grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-1.5 text-[12px]">
              <span className="text-faint">
                {price ? formatDecimal(price, priceDecimalsOf(market)) : UNAVAILABLE}
              </span>
              <span
                className={
                  change === null || change === undefined
                    ? "text-faint"
                    : change >= 0
                      ? "text-safe"
                      : "text-danger"
                }
              >
                {change === null || change === undefined
                  ? ""
                  : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}
              </span>
              <span className="text-faint col-span-2 text-left">
                {age === null ? "" : updatedText(age)}
              </span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
