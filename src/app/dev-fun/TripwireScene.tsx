"use client";

import { useMemo, useState } from "react";
import { AccountDock } from "@/components/AccountDock";
import { MarketChart } from "@/components/MarketChart";
import type { Candle, MarketInfo } from "@/lib/market-data/types";
import type { Position } from "@/lib/trading/types";

const MARKET: MarketInfo = {
  id: "SOL-PERP",
  kind: "perp",
  base: "SOL",
  quote: "USDC",
  tickSize: "0.010000",
  lotSize: "0.001000",
  maxLeverage: 20,
  markPrice: "71.16",
  markPriceUpdatedAtMs: 0,
  change24hPercent: 0,
  volume24h: "0",
  openInterest: "0",
};

const CANDLE_COUNT = 90;
const CANDLE_MS = 60_000;

function syntheticCandles(entry: number, mark: number, now: number): Candle[] {
  return Array.from({ length: CANDLE_COUNT }, (_, index) => {
    const share = index / (CANDLE_COUNT - 1);
    const close = entry + (mark - entry) * share ** 3 + Math.sin(index / 5) * 0.12;
    const open =
      index === 0 ? entry : entry + (mark - entry) * ((index - 1) / (CANDLE_COUNT - 1)) ** 3;
    const last = index === CANDLE_COUNT - 1;
    return {
      startMs: now - (CANDLE_COUNT - index) * CANDLE_MS,
      open: open.toFixed(2),
      high: (Math.max(open, close) + 0.05).toFixed(2),
      low: (Math.min(open, close) - 0.05).toFixed(2),
      close: (last ? mark : close).toFixed(2),
      volume: "1",
    };
  });
}

/** A chart ending at the mark and one open position, so the Tripwire's line, runway, bloom and card rule can be looked at. */
export function TripwireScene({ entry, mark }: { entry: number; mark: number }) {
  const [now] = useState(() => Date.now());
  const candles = useMemo(() => syntheticCandles(entry, mark, now), [entry, mark, now]);
  const position: Position = { market: MARKET.id, size: "0.208", entryPrice: entry.toFixed(2) };
  return (
    <>
      <section className="bg-surface rounded-panel flex min-h-0 flex-1 flex-col p-2">
        <MarketChart
          market={MARKET}
          candles={candles}
          mark={{ price: mark.toFixed(2), time: now }}
          publicFills={[]}
          ownSequences={new Set()}
          loading={false}
        />
      </section>
      <section className="hidden w-72 shrink-0 sm:block">
        <AccountDock
          tab="positions"
          onTabChange={() => {}}
          positions={[position]}
          openOrders={[]}
          ownFills={[]}
          balances={[]}
          collateral={null}
          marketSettings={(id) => (id === MARKET.id ? MARKET : undefined)}
          marksByMarket={{ [MARKET.id]: { price: mark.toFixed(2), time: now } }}
          now={now}
          hasWallet
          quoteSymbol="USDC"
          onTransfer={null}
          onClosePosition={() => {}}
          onReducePosition={() => {}}
          onCancelOrder={null}
          cancellingOrderIds={new Set()}
        />
      </section>
    </>
  );
}
