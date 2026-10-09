import type { CandleInterval } from "@/lib/market-data/types";

const INTERVALS: CandleInterval[] = ["1m", "5m", "15m", "1h"];

/** The chart column's own 64 px header: which market and interval, nothing else (the full market snapshot lives in MarketContextBar, so the two never disagree). */
export function MarketHeader({
  marketId,
  interval,
  onIntervalChange,
}: {
  marketId: string | undefined;
  interval: CandleInterval;
  onIntervalChange: (interval: CandleInterval) => void;
}) {
  return (
    <div className="flex h-8 items-center justify-between px-1">
      <span className="text-dim text-[12px]">{marketId ?? ""}</span>
      <div className="flex gap-1" role="group" aria-label="Chart period">
        {INTERVALS.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={interval === option}
            onClick={() => onIntervalChange(option)}
            className={`rounded-tile min-h-8 px-2 text-[12px] ${
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
