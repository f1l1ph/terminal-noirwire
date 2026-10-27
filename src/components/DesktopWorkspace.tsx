"use client";

import dynamic from "next/dynamic";
import { MarketContextBar } from "@/components/MarketContextBar";
import {
  TerminalPanelProvider,
  type TerminalPanelData,
} from "@/components/panels/TerminalPanelContext";

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
  quoteSymbol,
  takerFeeBps,
  layoutResetSignal,
  ...panelData
}: TerminalPanelData & {
  /** The quote token's name as the venue gives it (nUSD, USDC); empty while not yet known. */
  quoteSymbol: string;
  /** The market account's taker fee in basis points; undefined until the session has read it. */
  takerFeeBps?: number;
  /** Bumped by the shell's "Reset layout" link; rebuilds the default arrangement and clears the saved one. */
  layoutResetSignal: number;
}) {
  return (
    <>
      <div className="shrink-0">
        <MarketContextBar
          market={panelData.market}
          mark={panelData.mark}
          now={panelData.now}
          quoteSymbol={quoteSymbol}
          takerFeeBps={takerFeeBps}
        />
      </div>
      <TerminalPanelProvider value={panelData}>
        <TerminalDockview resetSignal={layoutResetSignal} />
      </TerminalPanelProvider>
    </>
  );
}
