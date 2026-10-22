"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { MarketContextBar } from "@/components/MarketContextBar";
import {
  TerminalPanelProvider,
  type TerminalPanelData,
} from "@/components/panels/TerminalPanelContext";
import type {
  Candle,
  CandleInterval,
  MarketInfo,
  PublicFill,
  StatsResponse,
} from "@/lib/market-data/types";
import type { ConnectionState } from "@/lib/market-data/socket";
import type { useTrading } from "@/lib/trading/useTrading";

/**
 * The real docking board depends on `dockview-react`; loading it through
 * `next/dynamic` with `ssr: false` keeps that dependency out of the server
 * render and, since this module itself has no static import of it, out of
 * the phone bundle too (the phone view never renders `DesktopWorkspace` at
 * all, so the dynamic import is never even requested there).
 */
const TerminalDockview = dynamic(
  () => import("@/components/TerminalDockview").then((mod) => mod.TerminalDockview),
  {
    ssr: false,
    loading: () => (
      <div className="bg-surface border-line-subtle rounded-panel min-h-0 flex-1 border" />
    ),
  },
);

/**
 * The desktop workspace: a fixed market context bar over the dockview
 * board. Placement, sizing, dragging, maximizing and persistence belong to
 * dockview (`TerminalDockview`); this component's only job is handing every
 * panel the live data and callbacks it needs through `TerminalPanelProvider`,
 * so dockview can mount, move, and resize panels freely without Terminal.tsx
 * ever being involved in where they sit.
 */
export function DesktopWorkspace({
  market,
  mark,
  now,
  quoteSymbol,
  interval,
  onIntervalChange,
  candles,
  tape,
  ownSequences,
  connectionState,
  candlesLoading,
  candlesFetchFailed,
  markStale,
  onRetry,
  markets,
  selectedMarketId,
  onSelectMarket,
  stats,
  network,
  clientDurationMs,
  witnessRail,
  checkPrivacy,
  orderEntry,
  accountDock,
  layoutResetSignal,
}: {
  market: MarketInfo | undefined;
  mark: { price: string; time: number } | null;
  now: number;
  /** The quote token's name as the venue gives it (nUSD, USDC); empty while not yet known. */
  quoteSymbol: string;
  interval: CandleInterval;
  onIntervalChange: (interval: CandleInterval) => void;
  candles: Candle[];
  tape: PublicFill[];
  ownSequences: ReadonlySet<number>;
  connectionState: ConnectionState;
  candlesLoading: boolean;
  candlesFetchFailed: boolean;
  markStale: boolean;
  onRetry: () => void;
  markets: MarketInfo[];
  selectedMarketId: string;
  onSelectMarket: (id: string) => void;
  stats: StatsResponse | null;
  network: string;
  clientDurationMs: number | null;
  witnessRail: ReactNode;
  checkPrivacy: ReturnType<typeof useTrading>["checkPrivacy"];
  orderEntry: ReactNode;
  accountDock: ReactNode;
  /** Bumped by the shell's "Reset layout" link; rebuilds the default arrangement and clears the saved one. */
  layoutResetSignal: number;
}) {
  const panelData: TerminalPanelData = {
    market,
    mark,
    now,
    interval,
    onIntervalChange,
    candles,
    tape,
    ownSequences,
    connectionState,
    candlesLoading,
    candlesFetchFailed,
    markStale,
    onRetry,
    markets,
    selectedMarketId,
    onSelectMarket,
    stats,
    network,
    clientDurationMs,
    checkPrivacy,
    orderEntry,
    witnessRail,
    accountDock,
  };

  return (
    <>
      <div className="shrink-0">
        <MarketContextBar market={market} mark={mark} now={now} quoteSymbol={quoteSymbol} />
      </div>
      <TerminalPanelProvider value={panelData}>
        <TerminalDockview resetSignal={layoutResetSignal} />
      </TerminalPanelProvider>
    </>
  );
}
