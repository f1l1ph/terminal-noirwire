import { formatPercent, formatPrice, formatRelativeAge, UNAVAILABLE } from "@/lib/format";
import { ageMs, isStale, STALE_MARK_MS } from "@/lib/market-data/selectors";
import type { CandleInterval } from "@/lib/market-data/types";
import type { MarketInfo } from "@/lib/market-data/types";

const INTERVALS: CandleInterval[] = ["1m", "5m", "15m", "1h"];

export function MarketHeader({
  market,
  mark,
  markUpdatedAt,
  interval,
  onIntervalChange,
  now,
}: {
  market: MarketInfo | undefined;
  mark: string | null;
  markUpdatedAt: number | null;
  interval: CandleInterval;
  onIntervalChange: (interval: CandleInterval) => void;
  now: number;
}) {
  const stale = isStale(markUpdatedAt, now, STALE_MARK_MS);
  const age = ageMs(markUpdatedAt, now);
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 px-1">
      <div>
        <h1 className="text-ink-strong text-[20px] font-semibold">{market?.id ?? UNAVAILABLE}</h1>
        <p className="tnum text-ink-strong mt-1 text-[28px] font-semibold">
          {mark && !stale ? formatPrice(mark, market?.priceDecimals ?? 2) : UNAVAILABLE}
        </p>
        <p className="text-faint mt-1 text-[12px]">
          Indicative mark, not a quote ·{" "}
          {age === null
            ? UNAVAILABLE
            : stale
              ? `stale, ${formatRelativeAge(age)}`
              : formatRelativeAge(age)}
          {market && market.change24h !== null ? ` · ${formatPercent(market.change24h)} 24h` : ""}
        </p>
      </div>
      <div className="flex gap-1" role="group" aria-label="Chart period">
        {INTERVALS.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={interval === option}
            onClick={() => onIntervalChange(option)}
            className={`rounded-tile min-h-11 px-3 text-[13px] ${
              interval === option
                ? "bg-elevated text-ink-strong"
                : "text-dim hover:bg-surface-raised"
            }`}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}
