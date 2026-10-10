import { formatDecimal, formatRelativeAge, UNAVAILABLE } from "@/lib/format";
import type { MarketInfo } from "@/lib/market-data/types";
import { ageMs, isStale, STALE_MARK_MS } from "@/lib/market-data/selectors";
import { priceDecimalsOf } from "@/lib/market-data/precision";
import { panel } from "@/components/ui/styles";

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
    <nav
      aria-label="Markets"
      className={`${panel} flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2`}
    >
      {markets.map((market) => {
        const selected = market.id === selectedId;
        const age = ageMs(market.markPriceUpdatedAtMs, now);
        const stale = isStale(market.markPriceUpdatedAtMs, now, STALE_MARK_MS);
        return (
          <button
            key={market.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(market.id)}
            className={`rounded-tile flex shrink-0 flex-col gap-0.5 px-3 py-2 text-left transition-colors ${
              selected ? "bg-elevated text-ink-strong" : "text-dim hover:bg-surface-raised"
            }`}
          >
            <span className="text-[13px] font-medium">{market.id}</span>
            <span
              className={`tnum flex items-center gap-2 text-[12px] ${stale ? "text-faint/70 italic" : "text-faint"}`}
            >
              {market.markPrice
                ? stale
                  ? `Last ${formatDecimal(market.markPrice, priceDecimalsOf(market))}`
                  : formatDecimal(market.markPrice, priceDecimalsOf(market))
                : UNAVAILABLE}
              <span>
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
