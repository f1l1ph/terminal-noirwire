"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { deriveOwnFills, type OwnFillRecord } from "@/lib/trading/tags";
import { deriveRollupOwnFills } from "@/lib/rollup/ownFills";
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
  // A shorter desktop viewport (1280x800 is the shortest this terminal is
  // checked against) gives the workspace row relatively more of the shared
  // height, so a perp market order still fits in the order entry column
  // without its own scroll; the account dock already scrolls its table
  // body internally, so it gives up height first.
  const isShortViewport = useMediaQuery("(max-height: 850px)");
  const [phoneView, setPhoneView] = useState<"trade" | "market">("trade");

  const wallet = useWallet();
  // Stable across renders (depends only on the markets array, which
  // changes rarely) so that useTrading's useMemo does not rebuild the
  // whole trading client - and in rollup mode, re-sign-in and re-subscribe
  // to the rollup - on every tick of `now` (every second). It did exactly
  // that before this was memoized: a brand new session and websocket
  // subscription every second, piling up faster than any of them could
  // close, until Chrome refused new ones ("Insufficient resources").
  const marketSettings = useCallback(
    (id: string) => data.markets.find((item) => item.id === id),
    [data.markets],
  );
  const trading = useTrading(wallet.account, marketSettings);

  const [orderSession, setOrderSession] = useState<OrderSession | null>(null);
  const [clientDurationMs, setClientDurationMs] = useState<number | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [accountRefreshedAt, setAccountRefreshedAt] = useState<number | null>(null);
  const lastOwnFillCountRef = useRef(0);

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

  async function handleCancelOrder(orderId: string): Promise<void> {
    if (!trading.cancelOrder) return;
    setCancelling(true);
    try {
      await trading.cancelOrder(selectedMarketId, orderId);
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

  const position = trading.state.positions[selectedMarketId] ?? null;
  const positionsArray = Object.values(trading.state.positions);
  const balancesArray = Object.values(trading.state.balances);
  const ownFillsForMarket: OwnFillRecord[] =
    trading.client.mode === "rollup"
      ? deriveRollupOwnFills(tape, trading.rollupSecrets)
      : deriveOwnFills(tape, trading.ownTags);
  // The tape/chart's "yours" marking takes sequence numbers, not a tag or a
  // receipt: the one identifier that means the same thing in both modes.
  const ownSequences = new Set(ownFillsForMarket.map((fill) => fill.sequence));

  // Rollup mode: a resting order's own fill does not update this trader's
  // view until `sync_view` runs (see TradingClient.syncMarket). Detected
  // here, where both the tape-derived own-fills and the tracked resting
  // order are in scope.
  useEffect(() => {
    if (ownFillsForMarket.length > lastOwnFillCountRef.current) {
      lastOwnFillCountRef.current = ownFillsForMarket.length;
      void trading.syncMarket(selectedMarketId);
    } else {
      lastOwnFillCountRef.current = ownFillsForMarket.length;
    }
  }, [ownFillsForMarket.length, selectedMarketId, trading]);

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
          : trackedFills.length > 0
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

  const orderEntry = market && (
    <OrderEntry
      key={market.id}
      market={market}
      mark={mark}
      now={now}
      hasWallet={!!wallet.account}
      walletReady={wallet.ready}
      balances={trading.state.balances}
      collateral={trading.state.collateral}
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
      onTransferToSpot={trading.transferBetweenBalances}
      supportsGoodFor={trading.client.mode === "rollup"}
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
      onCancelOrder={
        trading.cancelOrder && trackedOpenOrder
          ? () => void handleCancelOrder(trackedOpenOrder.orderId)
          : null
      }
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
      collateral={trading.state.collateral ?? null}
      marketSettings={marketSettings}
      hasWallet={!!wallet.account}
      onTransfer={trading.transferBetweenBalances}
    />
  );

  const content = isDesktop ? (
    <>
      <div className="shrink-0">
        <MarketContextBar market={market} mark={mark} now={now} />
      </div>
      <div
        className={`grid min-h-0 ${isShortViewport ? "flex-[7]" : "flex-[3]"} grid-cols-[176px_1fr_212px_296px] grid-rows-[minmax(0,1fr)] gap-2`}
      >
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
              ownSequences={ownSequences}
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
              ownSequences={ownSequences}
            />
          </div>
        </div>

        <div className="flex min-h-0 flex-col gap-2">
          <div className="shrink-0">
            <VenuePulse stats={data.stats} now={now} />
          </div>
          {witnessRail}
          <div className="shrink-0">
            <PublicView market={selectedMarketId} checkPrivacy={trading.checkPrivacy} />
          </div>
        </div>

        <div className="flex min-h-0 flex-col">{orderEntry}</div>
      </div>
      <div className={`flex ${isShortViewport ? "min-h-[90px]" : "min-h-[160px]"} flex-1 flex-col`}>
        {accountDock}
      </div>
    </>
  ) : (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
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
              ownSequences={ownSequences}
              connectionState={data.connectionState}
              loading={candlesLoading}
              onRetry={() => setRetryToken((token) => token + 1)}
            />
          </div>
          <PublicTape
            fills={tape}
            priceDecimals={market ? priceDecimalsOf(market) : 2}
            sizeDecimals={market ? sizeDecimalsOf(market) : 4}
            ownSequences={ownSequences}
          />
          <VenuePulse stats={data.stats} now={now} />
          <PublicView market={selectedMarketId} checkPrivacy={trading.checkPrivacy} />
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
