import { formatPrice, formatRelativeAge } from "@/lib/format";
import type { MarketInfo } from "@/lib/market-data/types";
import { ageMs } from "@/lib/market-data/selectors";
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
    <nav aria-label="Markets" className={`${panel} flex flex-col gap-1 p-2`}>
      {markets.map((market) => {
        const selected = market.id === selectedId;
        const age = ageMs(market.markPriceUpdatedAt, now);
        return (
          <button
            key={market.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(market.id)}
            className={`rounded-tile flex flex-col gap-0.5 px-3 py-2 text-left transition-colors ${
              selected ? "bg-elevated text-ink-strong" : "text-dim hover:bg-surface-raised"
            }`}
          >
            <span className="text-[13px] font-medium">{market.id}</span>
            <span className="tnum text-faint flex items-center gap-2 text-[12px]">
              {formatPrice(market.markPrice, market.priceDecimals)}
              <span>{age === null ? "" : formatRelativeAge(age)}</span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
