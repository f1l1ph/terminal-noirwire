import { formatDecimal, formatPercent, formatRelativeAge, UNAVAILABLE } from "@/lib/format";
import { ageMs, isStale, STALE_MARK_MS } from "@/lib/market-data/selectors";
import { priceDecimalsOf, sizeDecimalsOf } from "@/lib/market-data/precision";
import type { MarketInfo } from "@/lib/market-data/types";
import { panel } from "@/components/ui/styles";

/**
 * The full-width bar under the header: one current mark snapshot, shared
 * with the market list and the chart's own last-mark line, so the three
 * never disagree (the design review's complaint #5).
 */
export function MarketContextBar({
  market,
  mark,
  now,
}: {
  market: MarketInfo | undefined;
  mark: { price: string; time: number } | null;
  now: number;
}) {
  if (!market) {
    return (
      <div className={`${panel} text-faint flex h-14 items-center px-4 text-[13px]`}>
        Loading market settings.
      </div>
    );
  }
  const priceDecimals = priceDecimalsOf(market);
  const sizeDecimals = sizeDecimalsOf(market);
  const stale = isStale(mark?.time, now, STALE_MARK_MS);
  const age = ageMs(mark?.time, now);

  return (
    <div className={`${panel} flex h-14 items-center gap-6 px-4 text-[13px]`}>
      <span className="text-ink-strong font-semibold">{market.id}</span>
      <span className="tnum text-ink-strong flex items-baseline gap-2">
        {mark && !stale ? formatDecimal(mark.price, priceDecimals) : UNAVAILABLE}
        <span className="text-faint text-[11px] font-normal">
          {age === null
            ? UNAVAILABLE
            : stale
              ? `stale ${formatRelativeAge(age)}`
              : formatRelativeAge(age)}
        </span>
      </span>
      <span className="text-dim tnum">
        24h{" "}
        {market.change24hPercent === null ? UNAVAILABLE : formatPercent(market.change24hPercent)}
      </span>
      <span className="text-dim tnum">
        Vol {formatDecimal(market.volume24h, 2)} {market.quote}
      </span>
      {market.kind === "perp" && (
        <span className="text-dim tnum">
          OI {market.openInterest ? formatDecimal(market.openInterest, sizeDecimals) : UNAVAILABLE}{" "}
          {market.base}
        </span>
      )}
      <span className="text-faint ml-auto text-[11px]">TEST NETWORK</span>
    </div>
  );
}
