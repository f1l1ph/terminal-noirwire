"use client";

import { useState } from "react";
import { formatDecimal, formatUpdatedAge } from "@/lib/format";
import { ageMs, isStale, STALE_MARK_MS } from "@/lib/market-data/selectors";
import { priceDecimalsOf, sizeDecimalsOf } from "@/lib/market-data/precision";
import { ASSUMED_TAKER_FEE_BPS } from "@/lib/trading/risk";
import { changePercent, priceRange, rangeStartPrice } from "@/lib/market-data/reference-history";
import { useReferenceHistory } from "@/lib/market-data/useReferenceHistory";
import type { MarketInfo } from "@/lib/market-data/types";
import { panel } from "@/components/ui/styles";

type Mark = { price: string; time: number } | null;

/**
 * The price and its change over the past day. The mark is the one price
 * every surface reads; the change comes from the reference history while it
 * is available (this market is too new for its own 24 h figure to mean
 * anything), else from the market's own figure when it has one.
 */
export function PriceHeadline({
  market,
  mark,
  now,
  size = "large",
}: {
  market: MarketInfo | undefined;
  mark: Mark;
  now: number;
  size?: "large" | "compact";
}) {
  const reference = useReferenceHistory("1D");
  const priceDecimals = market ? priceDecimalsOf(market) : 2;
  const price = mark ? Number(mark.price) : NaN;
  const hasPrice = Number.isFinite(price);
  const age = ageMs(mark?.time, now);
  const stale = isStale(mark?.time, now, STALE_MARK_MS);

  const startPrice = rangeStartPrice(reference.candles);
  const referenceChange = hasPrice ? changePercent(startPrice, price) : null;
  const change = referenceChange ?? market?.change24hPercent ?? null;
  const changeAmount =
    referenceChange !== null && startPrice !== null && hasPrice ? price - startPrice : null;
  const changeColor = change !== null && change < 0 ? "text-danger" : "text-safe";
  const arrow = change !== null && change < 0 ? "▼" : "▲";
  const large = size === "large";

  return (
    <div className="flex min-w-0 flex-col">
      <span
        className={`tnum text-ink-strong leading-none font-semibold ${
          large ? "text-[32px]" : "text-[20px]"
        }`}
      >
        {hasPrice ? `$${formatDecimal(price, priceDecimals)}` : "Waiting for price"}
      </span>
      <span className={`tnum flex flex-wrap items-baseline gap-x-2 ${large ? "mt-1.5" : "mt-1"}`}>
        {change !== null && (
          <span
            className={`${changeColor} ${large ? "text-[14px]" : "text-[12px]"} font-medium`}
            title={
              referenceChange !== null
                ? "Change over the past 24 hours, from the SOL/USD reference price"
                : "Change over the past 24 hours"
            }
          >
            {arrow}{" "}
            {changeAmount !== null && large
              ? `$${formatDecimal(Math.abs(changeAmount), priceDecimals)} (${Math.abs(change).toFixed(2)}%)`
              : `${Math.abs(change).toFixed(2)}%`}
          </span>
        )}
        {change !== null && <span className="text-faint text-[11px]">past day</span>}
        {hasPrice && age !== null && (
          <span className={`text-[11px] ${stale ? "text-warning" : "text-faint"}`}>
            {formatUpdatedAge(age)}
          </span>
        )}
      </span>
    </div>
  );
}

function BarStat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-faint text-[11px]">{label}</span>
      <span className="text-ink text-[13px]">{value}</span>
    </span>
  );
}

function hasAmount(value: string | null | undefined): boolean {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

/**
 * The full-width bar under the header: one current mark snapshot, shared
 * with the market list and the chart's own last-mark line, so the three
 * never disagree.
 */
export function MarketContextBar({
  market,
  mark,
  now,
  quoteSymbol,
}: {
  market: MarketInfo | undefined;
  mark: Mark;
  now: number;
  /** The quote token's name as the venue gives it (nUSD, USDC); empty while not yet known. */
  quoteSymbol: string;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const reference = useReferenceHistory("1D");
  const dayRange = priceRange(reference.candles);

  if (!market) {
    return (
      <div className={`${panel} text-faint flex h-14 items-center px-4 text-[13px]`}>
        Loading market settings.
      </div>
    );
  }
  const sizeDecimals = sizeDecimalsOf(market);
  const priceDecimals = priceDecimalsOf(market);
  const showVolume = hasAmount(market.volume24h);
  const showOpenInterest = market.kind === "perp" && hasAmount(market.openInterest);
  const isPerp = market.kind === "perp";

  return (
    <div className={`${panel} relative flex flex-wrap items-center gap-x-8 gap-y-3 px-5 py-3`}>
      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-dim text-[12px] font-medium">SOL Perpetual</span>
        <PriceHeadline market={market} mark={mark} now={now} />
      </div>
      <div className="tnum mt-6 ml-auto flex flex-wrap items-start justify-end gap-x-8 gap-y-2 text-right">
        {dayRange && (
          <BarStat
            label="24h range"
            value={`${formatDecimal(dayRange.low, priceDecimals)} - ${formatDecimal(dayRange.high, priceDecimals)}`}
          />
        )}
        {isPerp && <BarStat label="Max leverage" value={`${market.maxLeverage}x`} />}
        {isPerp && <BarStat label="Taker fee" value={`${ASSUMED_TAKER_FEE_BPS / 100}%`} />}
        {showVolume && (
          <BarStat
            label="24h volume"
            value={`${formatDecimal(market.volume24h, 2)} ${quoteSymbol}`}
          />
        )}
        {showOpenInterest && (
          <BarStat
            label="Open interest"
            value={`${formatDecimal(market.openInterest ?? 0, sizeDecimals)} ${market.base}`}
          />
        )}
      </div>
      <button
        type="button"
        className="text-faint tnum absolute top-3 right-5 text-[11px] underline"
        onClick={() => setShowDetails((value) => !value)}
        aria-expanded={showDetails}
      >
        Market details
      </button>
      {showDetails && (
        <div className="bg-surface border-line-strong rounded-panel tnum absolute top-full right-4 z-10 mt-1 flex flex-col gap-1 border p-3 text-[12px] shadow-lg">
          <span className="text-dim">Tick {market.tickSize}</span>
          <span className="text-dim">Lot {market.lotSize}</span>
        </div>
      )}
    </div>
  );
}
