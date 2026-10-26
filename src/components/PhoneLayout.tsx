"use client";

import type { ReactNode } from "react";
import type { Candle, MarketInfo, PublicFill, StatsResponse } from "@/lib/market-data/types";
import { marketDisplayName } from "@/lib/market-data/displayName";
import { priceDecimalsOf, sizeDecimalsOf } from "@/lib/market-data/precision";
import type { useTrading } from "@/lib/trading/useTrading";
import { MarketChart } from "@/components/MarketChart";
import { PriceHeadline } from "@/components/MarketContextBar";
import { PrivacyToolsToggle } from "@/components/PrivacyToolsToggle";
import { PublicTape } from "@/components/PublicTape";
import { PublicView } from "@/components/PublicView";
import { VenuePulse } from "@/components/VenuePulse";

export type PhoneView = "trade" | "market" | "account";

/**
 * Phone layout: a 48 px sticky bar (market, side, quantity, status, the
 * primary action) always visible, with the first viewport showing side,
 * quantity, available balance and the action together - the second design
 * review's item 10. Secondary evidence (chart, tape, pulse, public view)
 * collapses behind the "Market" toggle, same as before.
 */
export function PhoneLayout({
  market,
  mark,
  markets,
  selectedMarketId,
  onSelectMarket,
  phoneView,
  onPhoneViewChange,
  orderEntry,
  witnessRail,
  accountDock,
  candles,
  tape,
  ownSequences,
  candlesLoading,
  stats,
  now,
  network,
  checkPrivacy,
  markStale,
  clientDurationMs,
  mainnet,
  toolsOn,
  orderNotice,
}: {
  market: MarketInfo | undefined;
  mark: { price: string; time: number } | null;
  now: number;
  markets: MarketInfo[];
  selectedMarketId: string;
  onSelectMarket: (market: string) => void;
  phoneView: PhoneView;
  onPhoneViewChange: (view: PhoneView) => void;
  mainnet: boolean;
  /** Whether the public tape, privacy check, timing and private order log are shown: always on test builds, a switch on mainnet. */
  toolsOn: boolean;
  orderNotice: ReactNode;
  orderEntry: ReactNode;
  witnessRail: ReactNode;
  accountDock: ReactNode;
  candles: Candle[];
  tape: PublicFill[];
  ownSequences: ReadonlySet<number>;
  candlesLoading: boolean;
  stats: StatsResponse | null;
  network: string;
  checkPrivacy: ReturnType<typeof useTrading>["checkPrivacy"];
  markStale: boolean;
  clientDurationMs: number | null;
}) {
  const views: { id: PhoneView; label: string }[] = mainnet
    ? [
        { id: "trade", label: "Trade" },
        { id: "market", label: "Chart" },
        { id: "account", label: "Account" },
      ]
    : [
        { id: "trade", label: "Trade" },
        { id: "market", label: "Market" },
      ];
  const chart = (
    <div className={`flex flex-col ${mainnet ? "h-[58dvh] min-h-[320px]" : "h-[260px]"}`}>
      <MarketChart
        market={market}
        candles={candles}
        mark={mark}
        publicFills={tape}
        ownSequences={ownSequences}
        loading={candlesLoading}
        markStale={markStale}
      />
    </div>
  );
  const marketTools = (
    <>
      <PublicTape
        fills={tape}
        priceDecimals={market ? priceDecimalsOf(market) : 2}
        sizeDecimals={market ? sizeDecimalsOf(market) : 4}
        ownSequences={ownSequences}
      />
      <VenuePulse stats={stats} now={now} network={network} clientDurationMs={clientDurationMs} />
      <PublicView market={selectedMarketId} checkPrivacy={checkPrivacy} />
    </>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
      {/* The sticky bar: market, price, change and its age, always visible. */}
      <div className="bg-surface border-line-subtle rounded-panel sticky top-0 z-10 flex shrink-0 items-center justify-between gap-3 px-3 py-2">
        <span className="text-ink-strong text-[13px] font-medium">
          {marketDisplayName(market?.id ?? "")}
        </span>
        <div className="min-w-0 [&>div]:items-end [&>div>span:last-child]:justify-end">
          <PriceHeadline market={market} mark={mark} now={now} size="compact" />
        </div>
      </div>
      {/* One compact market selector: a single row of chips, not the full desktop watchlist. */}
      {!mainnet && (
        <div className="flex gap-1.5 overflow-x-auto" role="group" aria-label="Markets">
          {markets.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={item.id === selectedMarketId}
              onClick={() => onSelectMarket(item.id)}
              className={`rounded-tile min-h-9 shrink-0 px-3 text-[12px] ${
                item.id === selectedMarketId
                  ? "bg-elevated text-ink-strong"
                  : "border-line text-dim border"
              }`}
            >
              {item.id}
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-2" role="group" aria-label="View">
        {views.map((view) => (
          <button
            key={view.id}
            type="button"
            aria-pressed={phoneView === view.id}
            onClick={() => onPhoneViewChange(view.id)}
            className={`rounded-tile min-h-11 flex-1 text-[13px] whitespace-nowrap ${phoneView === view.id ? "bg-elevated text-ink-strong" : "text-dim"}`}
          >
            {view.label}
          </button>
        ))}
      </div>
      {phoneView === "trade" && (
        <div className="flex flex-col gap-2">
          {orderEntry}
          {mainnet ? orderNotice : witnessRail}
          {!mainnet && accountDock}
        </div>
      )}
      {phoneView === "market" && (
        <div className="flex flex-col gap-2">
          {chart}
          {toolsOn && marketTools}
        </div>
      )}
      {phoneView === "account" && (
        <div className="flex flex-col gap-2">
          {orderNotice}
          <div className="flex min-h-[260px] flex-col [&_button]:whitespace-nowrap">
            {accountDock}
          </div>
          {toolsOn && witnessRail}
          <PrivacyToolsToggle className="self-start" />
        </div>
      )}
    </div>
  );
}
