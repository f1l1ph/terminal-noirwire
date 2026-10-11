"use client";

import type { ReactNode } from "react";
import { useElementSize } from "@/components/hooks/useElementSize";
import { usePanelDrag } from "@/components/hooks/usePanelDrag";
import type { PanelLayoutController } from "@/components/hooks/usePanelLayout";
import { MarketContextBar } from "@/components/MarketContextBar";
import { MarketSwitcher } from "@/components/MarketSwitcher";
import { MarketHeader } from "@/components/MarketHeader";
import { MarketChart } from "@/components/MarketChart";
import { VenuePulse } from "@/components/VenuePulse";
import { PublicTape } from "@/components/PublicTape";
import { PublicView } from "@/components/PublicView";
import { PanelFrame, type PanelGripConfig } from "@/components/PanelFrame";
import { Splitter } from "@/components/Splitter";
import { priceDecimalsOf, sizeDecimalsOf } from "@/lib/market-data/precision";
import type {
  Candle,
  CandleInterval,
  MarketInfo,
  PublicFill,
  StatsResponse,
} from "@/lib/market-data/types";
import type { ConnectionState } from "@/lib/market-data/socket";
import type { useTrading } from "@/lib/trading/useTrading";
import {
  COLUMN_SLOTS,
  CENTRE_PANELS,
  columnTrackSizes,
  centreRowSizes,
  effectiveDockHeight,
  MIN_CHART_WIDTH,
  MIN_CHART_HEIGHT,
  MIN_TAPE_HEIGHT,
  MIN_DOCK_HEIGHT,
  COLUMN_MIN_WIDTH,
  SPLITTER_SIZE,
  type ColumnSlotId,
  type CentrePanelId,
} from "@/lib/layout/panelLayout";

const PANEL_TITLES: Record<ColumnSlotId, string> = {
  markets: "Markets",
  centre: "Chart",
  evidence: "Evidence",
  ticket: "Order ticket",
};

/**
 * The desktop workspace: the four swappable/resizable/collapsible column
 * panels (Markets, the Chart/Public tape centre stack, Evidence, the Order
 * ticket) above the resizable/collapsible Account dock. Every panel is one
 * `PanelFrame`; `usePanelLayout` (owned by the caller, so the "Reset
 * layout" control in the shell header can read it too) is the single
 * source of truth for order, sizes and collapsed state, and this component
 * only turns that state into grid placement - it never unmounts a panel to
 * express a layout change (see the CRITICAL rule in the hook's own doc).
 */
export function DesktopWorkspace({
  layout,
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
  witnessRail,
  checkPrivacy,
  orderEntry,
  accountDock,
}: {
  layout: PanelLayoutController;
  market: MarketInfo | undefined;
  mark: { price: string; time: number } | null;
  now: number;
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
}) {
  const [topAreaRef, topAreaSize] = useElementSize<HTMLDivElement>();
  const [centreStackRef, centreStackSize] = useElementSize<HTMLDivElement>();
  const columnDrag = usePanelDrag<ColumnSlotId>(COLUMN_SLOTS, layout.swapColumnSlots);
  const centreDrag = usePanelDrag<CentrePanelId>(CENTRE_PANELS, layout.swapCentreRows);

  function columnGrip(slot: ColumnSlotId, label: string): PanelGripConfig {
    return {
      label,
      dragging: columnDrag.draggingId === slot,
      onPointerDown: columnDrag.handleGripPointerDown(slot),
      onPointerMove: columnDrag.handleGripPointerMove(slot),
      onPointerUp: columnDrag.endDrag(slot),
      onKeyDown: (event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          layout.moveColumnSlot(slot, -1);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          layout.moveColumnSlot(slot, 1);
        }
      },
    };
  }

  function columnGridLine(slot: ColumnSlotId): number {
    return 2 * layout.state.columnOrder.indexOf(slot) + 1;
  }

  function columnSplitterDisabled(leftSlot: ColumnSlotId, rightSlot: ColumnSlotId): boolean {
    const leftCollapsed =
      leftSlot !== "centre" && leftSlot !== "ticket" && layout.state.collapsed[leftSlot];
    const rightCollapsed =
      rightSlot !== "centre" && rightSlot !== "ticket" && layout.state.collapsed[rightSlot];
    return leftCollapsed || rightCollapsed;
  }

  function columnSplitterAria(leftSlot: ColumnSlotId, rightSlot: ColumnSlotId) {
    const explicitSlot =
      leftSlot !== "centre" ? leftSlot : rightSlot !== "centre" ? rightSlot : null;
    if (!explicitSlot) return { valueNow: 0, valueMin: 0, valueMax: 0 };
    const min = COLUMN_MIN_WIDTH[explicitSlot];
    const max = Math.max(min, topAreaSize.width - SPLITTER_SIZE * 3 - MIN_CHART_WIDTH);
    return { valueNow: layout.state.sizes[explicitSlot], valueMin: min, valueMax: max };
  }

  function centreGrip(id: CentrePanelId, label: string): PanelGripConfig {
    return {
      label,
      dragging: centreDrag.draggingId === id,
      onPointerDown: centreDrag.handleGripPointerDown(id),
      onPointerMove: centreDrag.handleGripPointerMove(id),
      onPointerUp: centreDrag.endDrag(id),
      onKeyDown: (event) => {
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          layout.swapCentreRows();
        }
      },
    };
  }

  function columnSplitter(positionIndex: 0 | 1 | 2) {
    const leftSlot = layout.state.columnOrder[positionIndex];
    const rightSlot = layout.state.columnOrder[positionIndex + 1];
    const gridColumn = 2 * (positionIndex + 1);
    return (
      <Splitter
        key={gridColumn}
        orientation="column"
        label={`Resize ${PANEL_TITLES[leftSlot]} and ${PANEL_TITLES[rightSlot]} panels`}
        {...columnSplitterAria(leftSlot, rightSlot)}
        disabled={columnSplitterDisabled(leftSlot, rightSlot)}
        onDelta={(delta) => layout.resizeBoundary(leftSlot, rightSlot, delta, topAreaSize.width)}
        style={{ gridColumn, gridRow: 1 }}
        className="h-full"
      />
    );
  }

  const centreSplitterDisabled = layout.state.collapsed.chart || layout.state.collapsed.tape;
  const centreUsableHeight = Math.max(0, centreStackSize.height - SPLITTER_SIZE);
  const chartShareHeight = layout.state.sizes.centreSplit * centreUsableHeight;
  const workspaceHeightPx = topAreaSize.height + SPLITTER_SIZE + effectiveDockHeight(layout.state);
  const dockSplitterDisabled = layout.state.collapsed.account;

  return (
    <>
      <div className="shrink-0">
        <MarketContextBar market={market} mark={mark} now={now} />
      </div>
      <div
        ref={topAreaRef}
        className="grid min-h-0 flex-1"
        style={{
          gridTemplateColumns: columnTrackSizes(layout.state).join(` ${SPLITTER_SIZE}px `),
          gridTemplateRows: "minmax(0, 1fr)",
        }}
      >
        <div
          ref={columnDrag.registerPanel("markets")}
          className="flex min-h-0 min-w-0 flex-col"
          style={{ gridColumn: columnGridLine("markets"), gridRow: 1 }}
        >
          <PanelFrame
            title="Markets"
            className="flex-1"
            grip={columnGrip("markets", "Move Markets panel")}
            collapse={{
              collapsed: layout.state.collapsed.markets,
              orientation: "column",
              onToggle: () => layout.toggleCollapse("markets"),
            }}
            dropHighlight={columnDrag.hoverId === "markets"}
          >
            <MarketSwitcher
              markets={markets}
              selectedId={selectedMarketId}
              onSelect={onSelectMarket}
              now={now}
            />
          </PanelFrame>
        </div>

        <div
          ref={(element) => {
            columnDrag.registerPanel("centre")(element);
            centreStackRef.current = element;
          }}
          className="grid min-h-0 min-w-0"
          style={{
            gridColumn: columnGridLine("centre"),
            gridRow: 1,
            gridTemplateRows: centreRowSizes(layout.state).join(` ${SPLITTER_SIZE}px `),
          }}
        >
          <div
            className="flex min-h-0 min-w-0 flex-col"
            style={{ gridRow: layout.state.centreOrder.indexOf("chart") === 0 ? 1 : 3 }}
          >
            <PanelFrame
              title="Chart"
              className="flex-1"
              grip={centreGrip("chart", "Move Chart panel")}
              collapse={{
                collapsed: layout.state.collapsed.chart,
                orientation: "row",
                onToggle: () => layout.toggleCollapse("chart"),
              }}
              dropHighlight={centreDrag.hoverId === "chart"}
              bodyClassName="gap-1 p-1"
            >
              <MarketHeader
                marketId={market?.id}
                interval={interval}
                onIntervalChange={onIntervalChange}
              />
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <MarketChart
                  market={market}
                  interval={interval}
                  candles={candles}
                  mark={mark}
                  publicFills={tape}
                  ownSequences={ownSequences}
                  connectionState={connectionState}
                  loading={candlesLoading}
                  fetchFailed={candlesFetchFailed}
                  markStale={markStale}
                  onRetry={onRetry}
                />
              </div>
            </PanelFrame>
          </div>

          <Splitter
            orientation="row"
            label="Resize Chart and Public tape panels"
            valueNow={chartShareHeight}
            valueMin={MIN_CHART_HEIGHT}
            valueMax={Math.max(MIN_CHART_HEIGHT, centreUsableHeight - MIN_TAPE_HEIGHT)}
            disabled={centreSplitterDisabled}
            onDelta={(delta) => layout.resizeCentre(delta, centreStackSize.height)}
            className="w-full"
            style={{ gridRow: 2 }}
          />

          <div
            className="flex min-h-0 min-w-0 flex-col"
            style={{ gridRow: layout.state.centreOrder.indexOf("tape") === 0 ? 1 : 3 }}
          >
            <PanelFrame
              title="Public tape"
              className="flex-1"
              grip={centreGrip("tape", "Move Public tape panel")}
              collapse={{
                collapsed: layout.state.collapsed.tape,
                orientation: "row",
                onToggle: () => layout.toggleCollapse("tape"),
              }}
              dropHighlight={centreDrag.hoverId === "tape"}
            >
              <PublicTape
                fills={tape}
                priceDecimals={market ? priceDecimalsOf(market) : 2}
                sizeDecimals={market ? sizeDecimalsOf(market) : 4}
                ownSequences={ownSequences}
                bordered={false}
              />
            </PanelFrame>
          </div>
        </div>

        {columnSplitter(0)}
        {columnSplitter(1)}
        {columnSplitter(2)}

        <div
          ref={columnDrag.registerPanel("evidence")}
          className="flex min-h-0 min-w-0 flex-col"
          style={{ gridColumn: columnGridLine("evidence"), gridRow: 1 }}
        >
          <PanelFrame
            title="Evidence"
            className="flex-1"
            grip={columnGrip("evidence", "Move Evidence panel")}
            collapse={{
              collapsed: layout.state.collapsed.evidence,
              orientation: "column",
              onToggle: () => layout.toggleCollapse("evidence"),
            }}
            dropHighlight={columnDrag.hoverId === "evidence"}
            bodyClassName="gap-2 overflow-y-auto p-2"
          >
            <div className="shrink-0">
              <VenuePulse
                stats={stats}
                now={now}
                network={network}
                clientDurationMs={clientDurationMs}
              />
            </div>
            {witnessRail}
            <div className="shrink-0">
              <PublicView market={selectedMarketId} checkPrivacy={checkPrivacy} />
            </div>
          </PanelFrame>
        </div>

        <div
          ref={columnDrag.registerPanel("ticket")}
          className="flex min-h-0 min-w-0 flex-col"
          style={{ gridColumn: columnGridLine("ticket"), gridRow: 1 }}
        >
          <PanelFrame
            title="Order ticket"
            className="flex-1"
            grip={columnGrip("ticket", "Move Order ticket panel")}
            dropHighlight={columnDrag.hoverId === "ticket"}
          >
            {orderEntry}
          </PanelFrame>
        </div>
      </div>

      <Splitter
        orientation="row"
        label="Resize the workspace and the account dock"
        valueNow={effectiveDockHeight(layout.state)}
        valueMin={MIN_DOCK_HEIGHT}
        valueMax={Math.max(
          MIN_DOCK_HEIGHT,
          workspaceHeightPx - MIN_CHART_HEIGHT - MIN_TAPE_HEIGHT - SPLITTER_SIZE,
        )}
        disabled={dockSplitterDisabled}
        onDelta={(delta) => layout.resizeDockHeight(delta, workspaceHeightPx)}
        className="w-full"
      />
      <div className="shrink-0" style={{ height: effectiveDockHeight(layout.state) }}>
        <PanelFrame
          title="Account"
          className="h-full"
          collapse={{
            collapsed: layout.state.collapsed.account,
            orientation: "row",
            onToggle: () => layout.toggleCollapse("account"),
          }}
        >
          {accountDock}
        </PanelFrame>
      </div>
    </>
  );
}
