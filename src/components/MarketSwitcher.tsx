import { formatDecimal, formatRelativeAge, UNAVAILABLE } from "@/lib/format";
import type { MarketInfo } from "@/lib/market-data/types";
import { ageMs, isStale, STALE_MARK_MS } from "@/lib/market-data/selectors";
import { priceDecimalsOf } from "@/lib/market-data/precision";

export function MarketSwitcher({
  markets,
  selectedId,
  onSelect,
  now,
}: {
  markets: MarketInfo[];
  selectedId: string;
  onSelect: (id: string) => void;
  now: number;
}) {
  return (
    <nav aria-label="Markets" className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-1.5">
      {markets.map((market) => {
        const selected = market.id === selectedId;
        const age = ageMs(market.markPriceUpdatedAtMs, now);
        const stale = isStale(market.markPriceUpdatedAtMs, now, STALE_MARK_MS);
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
              <span className={stale ? "text-faint/70 italic" : "text-faint"}>
                {market.markPrice
                  ? formatDecimal(market.markPrice, priceDecimalsOf(market))
                  : UNAVAILABLE}
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
                {age === null
                  ? ""
                  : stale
                    ? `${formatRelativeAge(age)} ago`
                    : formatRelativeAge(age)}
              </span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
