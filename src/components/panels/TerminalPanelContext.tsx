"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Candle, MarketInfo, PublicFill, StatsResponse } from "@/lib/market-data/types";
import type { LimitLine } from "@/lib/trading/limitLine";
import type { useTrading } from "@/lib/trading/useTrading";

/**
 * Everything a dockview panel component needs, in one place: dockview owns
 * placement (order, size, which group, which tab), Terminal.tsx owns every
 * value here. A panel component is a thin reader of this context plus
 * whichever already-built node (`orderEntry`, `witnessRail`, `accountDock`)
 * it renders - it never receives data through dockview's own `params`.
 */
export interface TerminalPanelData {
  market: MarketInfo | undefined;
  mark: { price: string; time: number } | null;
  now: number;
  candles: Candle[];
  tape: PublicFill[];
  ownSequences: ReadonlySet<number>;
  candlesLoading: boolean;
  markStale: boolean;
  /** The order form's draft limit price, drawn on the chart; null when the form is not a limit order with a valid price. */
  limitLine: LimitLine | null;
  markets: MarketInfo[];
  selectedMarketId: string;
  onSelectMarket: (id: string) => void;
  stats: StatsResponse | null;
  network: string;
  clientDurationMs: number | null;
  checkPrivacy: ReturnType<typeof useTrading>["checkPrivacy"];
  /** Already-built, stateful nodes - rendering them straight from context is what lets the order ticket's draft, the account dock's selected tab (itself lifted into Terminal.tsx), and the rail's own state survive a layout change. */
  orderEntry: ReactNode;
  witnessRail: ReactNode;
  accountDock: ReactNode;
  /** The result of the last order, shown above the account where the order log is not on screen; null when there is nothing to say. */
  orderNotice: ReactNode;
}

const TerminalPanelContext = createContext<TerminalPanelData | null>(null);

export function TerminalPanelProvider({
  value,
  children,
}: {
  value: TerminalPanelData;
  children: ReactNode;
}) {
  return <TerminalPanelContext.Provider value={value}>{children}</TerminalPanelContext.Provider>;
}

/** Dockview renders panel components through React portals that stay inside this provider's tree, so this works from any registered panel component. */
export function useTerminalPanelData(): TerminalPanelData {
  const data = useContext(TerminalPanelContext);
  if (!data) throw new Error("useTerminalPanelData must be used within a TerminalPanelProvider");
  return data;
}
