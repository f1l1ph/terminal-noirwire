"use client";

import { useState } from "react";
import { env } from "@/lib/env";
import { MARKET_IDS } from "@/lib/market-data/types";
import type { CandleInterval } from "@/lib/market-data/types";
import {
  useMarketDataConnection,
  useMarketDataState,
  useSharedMarketDataStore,
} from "@/lib/market-data/hooks";
import { useWallet } from "@/lib/wallet/useWallet";
import { useTrading, type NewOrderDraft, type PlacedOrderOutcome } from "@/lib/trading/useTrading";
import { useNow } from "@/components/hooks/useNow";
import { useMediaQuery } from "@/components/hooks/useMediaQuery";
import { TerminalShell } from "@/components/TerminalShell";
import { MarketSwitcher } from "@/components/MarketSwitcher";
import { MarketHeader } from "@/components/MarketHeader";
import { MarketChart } from "@/components/MarketChart";
import { VenuePulse } from "@/components/VenuePulse";
import { PublicTape } from "@/components/PublicTape";
import { PublicView } from "@/components/PublicView";
import { WitnessRail, type RailStep, type RailStepType } from "@/components/WitnessRail";
import { OrderEntry } from "@/components/OrderEntry";
import { AccountDock } from "@/components/AccountDock";
import { FirstRunStrip } from "@/components/FirstRunStrip";
import { formatEventTime } from "@/lib/format";

export function Terminal() {
  const store = useSharedMarketDataStore();
  const [selectedMarketId, setSelectedMarketId] = useState<string>(MARKET_IDS[0]);
  const [interval, setInterval] = useState<CandleInterval>("1m");
  useMarketDataConnection(store, env.simUrl, env.simWsUrl, selectedMarketId, interval);
  const data = useMarketDataState(store);
  const now = useNow();
  const isDesktop = useMediaQuery("(min-width: 900px)");
  const [phoneView, setPhoneView] = useState<"trade" | "market">("trade");

  const wallet = useWallet();
  const trading = useTrading(wallet.account?.publicKey ?? null);

  /**
   * The locally-known part of this order's timeline (submitted, then
   * confirmed or rejected), set only from the submit event itself. Resting,
   * partially filled and filled are derived at render time from the
   * trader's live state below, not accumulated in an effect: a market's
   * open order and fills already carry everything needed to know the rest
   * of the story.
   */
  const [orderSession, setOrderSession] = useState<{
    market: string;
    baseSteps: RailStep[];
    orderId: string | null;
    clientDurationMs: number;
  } | null>(null);
  const [cancelling, setCancelling] = useState(false);

  function handleOrderPlaced(outcome: PlacedOrderOutcome, draft: NewOrderDraft) {
    const submittedAt = Date.now() - Math.round(outcome.clientDurationMs);
    const baseSteps: RailStep[] = [{ type: "submitted", at: submittedAt }];
    if (outcome.result.status === "accepted") {
      baseSteps.push({ type: "confirmed", at: outcome.result.confirmedAt });
    } else {
      baseSteps.push({
        type: "rejected",
        at: outcome.result.confirmedAt,
        detail: outcome.result.reason,
      });
    }
    setOrderSession({
      market: draft.market,
      baseSteps,
      orderId: outcome.result.status === "accepted" ? outcome.result.orderId : null,
      clientDurationMs: outcome.clientDurationMs,
    });
  }

  async function handleCancel() {
    const openOrder = trading.state.openOrders.find((order) => order.market === selectedMarketId);
    if (!openOrder) return;
    setCancelling(true);
    try {
      await trading.cancelOrder(selectedMarketId, openOrder.orderId);
    } finally {
      setCancelling(false);
    }
  }

  const market = data.markets.find((item) => item.id === selectedMarketId);
  const mark = data.marksByMarket[selectedMarketId] ?? null;
  const tape = data.tapeByMarket[selectedMarketId] ?? [];
  const candles = data.candlesByMarket[selectedMarketId]?.[interval] ?? [];
  const marketSettings = (id: string) => data.markets.find((item) => item.id === id);

  const quoteBalance = trading.state.balances.find(
    (balance) => balance.asset === market?.quoteSymbol,
  );
  const availableNusd = quoteBalance?.available ?? (wallet.account ? "0" : null);
  const position = trading.state.positions.find((item) => item.market === selectedMarketId) ?? null;
  const openOrder =
    trading.state.openOrders.find((item) => item.market === selectedMarketId) ?? null;
  const ownFillsForMarket = trading.state.ownFills.filter(
    (item) => item.market === selectedMarketId,
  );

  const relevantSession = orderSession?.market === selectedMarketId ? orderSession : null;
  const trackedOrder = relevantSession?.orderId
    ? (trading.state.openOrders.find((order) => order.orderId === relevantSession.orderId) ?? null)
    : null;
  const trackedFills = relevantSession?.orderId
    ? ownFillsForMarket.filter((fill) => fill.orderId === relevantSession.orderId)
    : [];
  const railSteps: RailStep[] = relevantSession
    ? [
        ...relevantSession.baseSteps,
        ...(trackedOrder
          ? [
              {
                type: (Number(trackedOrder.filledQuantity) > 0
                  ? "partiallyFilled"
                  : "resting") as RailStepType,
                at: trackedOrder.placedAt,
              },
            ]
          : relevantSession.orderId && trackedFills.length > 0
            ? [
                {
                  type: "filled" as RailStepType,
                  at: trackedFills.reduce((max, fill) => Math.max(max, fill.time), 0),
                },
              ]
            : []),
      ]
    : [];
  const clientDurationMs = relevantSession?.clientDurationMs ?? null;

  const statusBarText = market
    ? `${market.id} · tick ${market.tickSize} · lot ${market.lotSize} · max leverage ${market.maxLeverage}x · ${env.networkLabel} · last data ${formatEventTime(new Date(now), new Date(now))}`
    : env.networkLabel;

  async function handleFund() {
    await trading.fund();
  }

  const rollupNotConnected = trading.client.mode === "rollup";

  const content = isDesktop ? (
    <div className="mx-auto flex max-w-[1440px] flex-col gap-3">
      {rollupNotConnected && (
        <p className="border-warning/40 bg-warning/5 text-warning rounded-panel border px-4 py-3 text-[13px]">
          The rollup trading client is not connected yet. Trading is unavailable in this build.
        </p>
      )}
      <FirstRunStrip
        hasWallet={!!wallet.account}
        onCreateWallet={() => wallet.create()}
        creating={false}
      />
      <div className="grid grid-cols-[220px_1fr_260px_300px] grid-rows-[auto_auto] gap-2">
        <div className="col-start-1 row-span-2 row-start-1">
          <MarketSwitcher
            markets={data.markets}
            selectedId={selectedMarketId}
            onSelect={setSelectedMarketId}
            now={now}
          />
        </div>
        <div className="col-start-2 row-start-1 flex flex-col gap-2">
          <MarketHeader
            market={market}
            mark={mark?.price ?? null}
            markUpdatedAt={mark?.time ?? null}
            interval={interval}
            onIntervalChange={setInterval}
            now={now}
          />
          <MarketChart candles={candles} mark={mark} fills={tape} stale={!mark} />
        </div>
        <div className="col-start-3 row-start-1 flex flex-col gap-2">
          <VenuePulse stats={data.stats} now={now} />
          <WitnessRail
            steps={railSteps}
            openOrder={openOrder}
            fills={ownFillsForMarket}
            sizeDecimals={market?.sizeDecimals ?? 4}
            clientDurationMs={clientDurationMs}
            onCancel={() => void handleCancel()}
            cancelling={cancelling}
          />
        </div>
        <div className="col-start-4 row-span-2 row-start-1">
          <OrderEntry
            key={market?.id ?? "none"}
            market={market}
            mark={mark}
            now={now}
            hasWallet={!!wallet.account}
            availableNusd={availableNusd}
            position={position}
            placeOrder={trading.placeOrder}
            onOrderPlaced={handleOrderPlaced}
          />
          {wallet.account && (
            <button
              type="button"
              className="text-ink mt-2 w-full text-[12px] underline"
              onClick={() => void handleFund()}
            >
              Get 5,000 test USD
            </button>
          )}
        </div>
        <div className="col-start-2 row-start-2">
          <PublicTape
            fills={tape}
            priceDecimals={market?.priceDecimals ?? 2}
            sizeDecimals={market?.sizeDecimals ?? 4}
            ownTags={trading.ownTags}
          />
        </div>
        <div className="col-start-3 row-start-2">
          <PublicView market={selectedMarketId} />
        </div>
      </div>
      <AccountDock
        positions={trading.state.positions}
        openOrders={trading.state.openOrders}
        fills={trading.state.ownFills}
        balances={trading.state.balances}
        marketSettings={marketSettings}
        hasWallet={!!wallet.account}
      />
    </div>
  ) : (
    <div className="flex flex-col gap-3">
      {rollupNotConnected && (
        <p className="border-warning/40 bg-warning/5 text-warning rounded-panel border px-4 py-3 text-[13px]">
          The rollup trading client is not connected yet. Trading is unavailable in this build.
        </p>
      )}
      <FirstRunStrip
        hasWallet={!!wallet.account}
        onCreateWallet={() => wallet.create()}
        creating={false}
      />
      <MarketSwitcher
        markets={data.markets}
        selectedId={selectedMarketId}
        onSelect={setSelectedMarketId}
        now={now}
      />
      <div className="flex gap-2" role="group" aria-label="View">
        <button
          type="button"
          aria-pressed={phoneView === "trade"}
          onClick={() => setPhoneView("trade")}
          className={`rounded-tile min-h-11 flex-1 text-[13px] ${phoneView === "trade" ? "bg-elevated text-ink-strong" : "text-dim"}`}
        >
          Trade
        </button>
        <button
          type="button"
          aria-pressed={phoneView === "market"}
          onClick={() => setPhoneView("market")}
          className={`rounded-tile min-h-11 flex-1 text-[13px] ${phoneView === "market" ? "bg-elevated text-ink-strong" : "text-dim"}`}
        >
          Market
        </button>
      </div>
      {phoneView === "trade" ? (
        <div className="flex flex-col gap-2">
          <OrderEntry
            key={market?.id ?? "none"}
            market={market}
            mark={mark}
            now={now}
            hasWallet={!!wallet.account}
            availableNusd={availableNusd}
            position={position}
            placeOrder={trading.placeOrder}
            onOrderPlaced={handleOrderPlaced}
          />
          <WitnessRail
            steps={railSteps}
            openOrder={openOrder}
            fills={ownFillsForMarket}
            sizeDecimals={market?.sizeDecimals ?? 4}
            clientDurationMs={clientDurationMs}
            onCancel={() => void handleCancel()}
            cancelling={cancelling}
          />
          <AccountDock
            positions={trading.state.positions}
            openOrders={trading.state.openOrders}
            fills={trading.state.ownFills}
            balances={trading.state.balances}
            marketSettings={marketSettings}
            hasWallet={!!wallet.account}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <MarketHeader
            market={market}
            mark={mark?.price ?? null}
            markUpdatedAt={mark?.time ?? null}
            interval={interval}
            onIntervalChange={setInterval}
            now={now}
          />
          <MarketChart candles={candles} mark={mark} fills={tape} stale={!mark} />
          <PublicTape
            fills={tape}
            priceDecimals={market?.priceDecimals ?? 2}
            sizeDecimals={market?.sizeDecimals ?? 4}
            ownTags={trading.ownTags}
          />
          <VenuePulse stats={data.stats} now={now} />
          <PublicView market={selectedMarketId} />
        </div>
      )}
    </div>
  );

  return (
    <TerminalShell
      connectionState={data.connectionState}
      wallet={wallet}
      statusBarText={statusBarText}
    >
      {content}
    </TerminalShell>
  );
}
