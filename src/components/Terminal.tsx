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
import { candlesLoadingKey } from "@/lib/market-data/selectors";
import { useWallet } from "@/lib/wallet/useWallet";
import { useTrading, type PlacedOrderOutcome } from "@/lib/trading/useTrading";
import { deriveOwnFills } from "@/lib/trading/tags";
import { describeRejectReason } from "@/lib/trading/validation";
import { useNow } from "@/components/hooks/useNow";
import { useMediaQuery } from "@/components/hooks/useMediaQuery";
import { TerminalShell } from "@/components/TerminalShell";
import { MarketSwitcher } from "@/components/MarketSwitcher";
import { MarketContextBar } from "@/components/MarketContextBar";
import { MarketHeader } from "@/components/MarketHeader";
import { MarketChart } from "@/components/MarketChart";
import { VenuePulse } from "@/components/VenuePulse";
import { PublicTape } from "@/components/PublicTape";
import { PublicView } from "@/components/PublicView";
import {
  WitnessRail,
  type OrderDescriptor,
  type RailStep,
  type RailStepType,
} from "@/components/WitnessRail";
import { OrderEntry } from "@/components/OrderEntry";
import { AccountDock } from "@/components/AccountDock";
import { formatClockTime } from "@/lib/format";
import { priceDecimalsOf, sizeDecimalsOf } from "@/lib/market-data/precision";

interface OrderSession {
  market: string;
  descriptor: OrderDescriptor;
  baseSteps: RailStep[];
  trackedOrderId: string | null;
  trackedTag: string | null;
}

export function Terminal() {
  const store = useSharedMarketDataStore();
  const [selectedMarketId, setSelectedMarketId] = useState<string>(MARKET_IDS[0]);
  const [interval, setInterval] = useState<CandleInterval>("1m");
  const [retryToken, setRetryToken] = useState(0);
  useMarketDataConnection(store, env.simUrl, env.simWsUrl, selectedMarketId, interval, retryToken);
  const data = useMarketDataState(store);
  const now = useNow();
  const isDesktop = useMediaQuery("(min-width: 900px)");
  const [phoneView, setPhoneView] = useState<"trade" | "market">("trade");

  const wallet = useWallet();
  const trading = useTrading(wallet.account?.publicKey ?? null);

  const [orderSession, setOrderSession] = useState<OrderSession | null>(null);
  const [clientDurationMs, setClientDurationMs] = useState<number | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [accountRefreshedAt, setAccountRefreshedAt] = useState<number | null>(null);

  function appendStep(
    prev: RailStep[],
    type: RailStepType,
    at: number,
    detail?: string,
  ): RailStep[] {
    if (prev.at(-1)?.type === type) return prev;
    return [...prev, { type, at, detail }];
  }

  function handleOrderPlaced(outcome: PlacedOrderOutcome, descriptor: OrderDescriptor): void {
    const submittedAt = Date.now() - Math.round(outcome.clientDurationMs);
    const baseSteps: RailStep[] = [{ type: "submitted", at: submittedAt }];
    setClientDurationMs(outcome.clientDurationMs);
    if (outcome.result.status === "rejected") {
      setOrderSession({
        market: descriptor.market,
        descriptor,
        baseSteps: appendStep(
          baseSteps,
          "rejected",
          Date.now(),
          describeRejectReason(outcome.result.reason ?? ""),
        ),
        trackedOrderId: null,
        trackedTag: null,
      });
      return;
    }
    setOrderSession({
      market: descriptor.market,
      descriptor,
      baseSteps: appendStep(baseSteps, "confirmed", Date.now()),
      trackedOrderId: outcome.result.orderId,
      trackedTag: outcome.result.tag,
    });
  }

  async function handleCancelAll(): Promise<void> {
    setCancelling(true);
    try {
      await trading.cancelAllInMarket(selectedMarketId);
      setOrderSession((prev) =>
        prev && prev.market === selectedMarketId
          ? {
              ...prev,
              baseSteps: appendStep(
                prev.baseSteps,
                "cancelled",
                Date.now(),
                "Cancelled by request.",
              ),
            }
          : prev,
      );
    } finally {
      setCancelling(false);
    }
  }

  const market = data.markets.find((item) => item.id === selectedMarketId);
  const mark = data.marksByMarket[selectedMarketId] ?? null;
  const tape = data.tapeByMarket[selectedMarketId] ?? [];
  const candles = data.candlesByMarket[selectedMarketId]?.[interval] ?? [];
  const candlesLoading = data.candlesLoading[candlesLoadingKey(selectedMarketId, interval)] ?? true;
  const marketSettings = (id: string) => data.markets.find((item) => item.id === id);

  const position = trading.state.positions[selectedMarketId] ?? null;
  const positionsArray = Object.values(trading.state.positions);
  const balancesArray = Object.values(trading.state.balances);
  const ownFillsForMarket = deriveOwnFills(tape, trading.ownTags);

  const relevantSession = orderSession?.market === selectedMarketId ? orderSession : null;
  const trackedOpenOrder = relevantSession?.trackedOrderId
    ? (trading.state.openOrders.find((order) => order.orderId === relevantSession.trackedOrderId) ??
      null)
    : null;
  const trackedFills = relevantSession?.trackedTag
    ? ownFillsForMarket.filter((fill) => fill.tag === relevantSession.trackedTag)
    : [];
  const railSteps: RailStep[] = relevantSession
    ? [
        ...relevantSession.baseSteps,
        ...(trackedOpenOrder
          ? [
              {
                type: (Number(trackedOpenOrder.remainingSize) < Number(trackedOpenOrder.size)
                  ? "partiallyFilled"
                  : "resting") as RailStepType,
                at: now,
              },
            ]
          : relevantSession.trackedOrderId && trackedFills.length > 0
            ? [
                {
                  type: "filled" as RailStepType,
                  at: trackedFills.reduce((max, fill) => Math.max(max, fill.timestampMs), 0),
                },
              ]
            : []),
      ]
    : [];

  const statusBarText = market
    ? `${market.id} · tick ${market.tickSize} · lot ${market.lotSize} · max leverage ${market.maxLeverage}x · ${env.networkLabel} · last data ${mark ? formatClockTime(new Date(mark.time)) : "unavailable"} · account ${accountRefreshedAt ? `refreshed at ${formatClockTime(new Date(accountRefreshedAt))}` : "not yet synced"}`
    : env.networkLabel;

  const rollupNotConnected = trading.client.mode === "rollup";

  const orderEntry = market && (
    <OrderEntry
      key={market.id}
      market={market}
      mark={mark}
      now={now}
      hasWallet={!!wallet.account}
      walletReady={wallet.ready}
      balances={trading.state.balances}
      position={position}
      onCreateWallet={() => wallet.create()}
      creatingWallet={false}
      onFund={async () => {
        const outcome = await trading.fund();
        setAccountRefreshedAt(Date.now());
        return outcome;
      }}
      placeOrder={trading.placeOrder}
      onOrderPlaced={handleOrderPlaced}
    />
  );

  const witnessRail = (
    <WitnessRail
      order={relevantSession?.descriptor ?? null}
      steps={railSteps}
      openOrder={trackedOpenOrder}
      ownFills={trackedFills}
      clientDurationMs={clientDurationMs}
      onCancelAll={() => void handleCancelAll()}
      cancelling={cancelling}
      now={now}
    />
  );

  const accountDock = (
    <AccountDock
      positions={positionsArray}
      openOrders={trading.state.openOrders}
      ownFills={ownFillsForMarket}
      balances={balancesArray}
      marketSettings={marketSettings}
      hasWallet={!!wallet.account}
    />
  );

  const rollupBanner = rollupNotConnected && (
    <p className="border-warning/40 bg-warning/5 text-warning rounded-panel border px-3 py-2 text-[12px]">
      The rollup trading client is not connected yet. Trading is unavailable in this build.
    </p>
  );

  const content = isDesktop ? (
    <>
      {rollupBanner}
      <div className="shrink-0">
        <MarketContextBar market={market} mark={mark} now={now} />
      </div>
      <div className="grid min-h-0 flex-[3] grid-cols-[176px_1fr_212px_296px] grid-rows-[minmax(0,1fr)] gap-2">
        <div className="flex min-h-0 flex-col">
          <MarketSwitcher
            markets={data.markets}
            selectedId={selectedMarketId}
            onSelect={setSelectedMarketId}
            now={now}
          />
        </div>

        <div className="flex min-h-0 min-w-0 flex-col gap-1">
          <MarketHeader marketId={market?.id} interval={interval} onIntervalChange={setInterval} />
          <div className="flex min-h-0 flex-[3] flex-col">
            <MarketChart
              market={market}
              candles={candles}
              mark={mark}
              publicFills={tape}
              ownTags={trading.ownTags}
              connectionState={data.connectionState}
              loading={candlesLoading}
              onRetry={() => setRetryToken((token) => token + 1)}
            />
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <PublicTape
              fills={tape}
              priceDecimals={market ? priceDecimalsOf(market) : 2}
              sizeDecimals={market ? sizeDecimalsOf(market) : 4}
              ownTags={trading.ownTags}
            />
          </div>
        </div>

        <div className="flex min-h-0 flex-col gap-2">
          <div className="shrink-0">
            <VenuePulse stats={data.stats} now={now} />
          </div>
          {witnessRail}
          <div className="shrink-0">
            <PublicView market={selectedMarketId} />
          </div>
        </div>

        <div className="flex min-h-0 flex-col">{orderEntry}</div>
      </div>
      <div className="flex min-h-[160px] flex-1 flex-col">{accountDock}</div>
    </>
  ) : (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
      {rollupBanner}
      {/* A 52 px sticky bar: symbol, mark and change, always visible, never repeated below. */}
      <div className="bg-surface border-line-subtle rounded-panel sticky top-0 z-10 flex h-13 shrink-0 items-center justify-between px-3 text-[13px]">
        <span className="text-ink-strong font-medium">{market?.id ?? ""}</span>
        <span className="tnum flex items-center gap-2">
          <span className="text-ink">{mark ? mark.price : "Unavailable"}</span>
          {market?.change24hPercent !== null && market?.change24hPercent !== undefined && (
            <span className={market.change24hPercent >= 0 ? "text-safe" : "text-danger"}>
              {market.change24hPercent >= 0 ? "+" : ""}
              {market.change24hPercent.toFixed(2)}%
            </span>
          )}
        </span>
      </div>
      {/* One compact market selector: a single row of chips, not the full desktop watchlist. */}
      <div className="flex gap-1.5 overflow-x-auto" role="group" aria-label="Markets">
        {data.markets.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={item.id === selectedMarketId}
            onClick={() => setSelectedMarketId(item.id)}
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
          {orderEntry}
          {witnessRail}
          {accountDock}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex h-[260px] flex-col">
            <MarketChart
              market={market}
              candles={candles}
              mark={mark}
              publicFills={tape}
              ownTags={trading.ownTags}
              connectionState={data.connectionState}
              loading={candlesLoading}
              onRetry={() => setRetryToken((token) => token + 1)}
            />
          </div>
          <PublicTape
            fills={tape}
            priceDecimals={market ? priceDecimalsOf(market) : 2}
            sizeDecimals={market ? sizeDecimalsOf(market) : 4}
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
