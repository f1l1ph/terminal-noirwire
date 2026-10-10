"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { env } from "@/lib/env";
import { MARKET_IDS } from "@/lib/market-data/types";
import type {
  Candle,
  CandleInterval,
  MarketInfo,
  PublicFill,
  StatsResponse,
} from "@/lib/market-data/types";
import type { ConnectionState } from "@/lib/market-data/socket";
import {
  useMarketDataConnection,
  useMarketDataState,
  useSharedMarketDataStore,
} from "@/lib/market-data/hooks";
import { candlesLoadingKey, isStale, STALE_MARK_MS } from "@/lib/market-data/selectors";
import { useWallet } from "@/lib/wallet/useWallet";
import { useTrading, type PlacedOrderOutcome } from "@/lib/trading/useTrading";
import type { CancelResult, Position } from "@/lib/trading/types";
import { deriveOwnFills, type OwnFillRecord } from "@/lib/trading/tags";
import { deriveRollupOwnFills } from "@/lib/rollup/ownFills";
import { fetchDeployment } from "@/lib/rollup/deployment";
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
  type RecentMarketActivity,
} from "@/components/WitnessRail";
import { OrderEntry, type PrefillRequest } from "@/components/OrderEntry";
import { AccountDock, type Tab } from "@/components/AccountDock";
import { formatClockTime, formatDecimal } from "@/lib/format";
import { priceDecimalsOf, sizeDecimalsOf } from "@/lib/market-data/precision";

interface OrderSession {
  market: string;
  descriptor: OrderDescriptor;
  baseSteps: RailStep[];
  trackedOrderId: string | null;
  trackedTag: string | null;
  /**
   * Set while this order's own outcome is not yet certain (rollup mode,
   * 0.3.1): the device gave up waiting while it could still run. Blocks
   * resubmitting an order in this market (the same intent) until it clears,
   * but not cancelling or transferring - those use other order-key slots.
   */
  pendingPlace: { expiresAtMs: number } | null;
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
  const [dockTab, setDockTab] = useState<Tab>("positions");

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

  // Dev mode is always an in-memory, same-process engine - "localnet" in
  // spirit regardless of label. Rollup mode reads the real value from
  // sim-noirwire's own deployment description (no wallet needed; this is
  // the same cached fetch `RollupTradingClient` makes once a wallet
  // exists), so a speed figure never claims "local" for a public network
  // or vice versa (second design review, item 3).
  const [network, setNetwork] = useState<string>("localnet");
  useEffect(() => {
    if (trading.client.mode !== "rollup") return;
    let cancelled = false;
    fetchDeployment(env.simUrl)
      .then((deployment) => {
        if (!cancelled) setNetwork(deployment.network);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [trading.client.mode]);

  // One session per market, not one session total: switching markets must
  // not erase what happened in another one (second design review, item 5).
  const [orderSessions, setOrderSessions] = useState<Record<string, OrderSession>>({});
  const [clientDurationMs, setClientDurationMs] = useState<number | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelPending, setCancelPending] = useState<{ expiresAtMs: number } | null>(null);
  const [cancelMessage, setCancelMessage] = useState<string | null>(null);
  const [prefillRequest, setPrefillRequest] = useState<PrefillRequest | null>(null);
  const lastOwnFillCountRef = useRef(0);
  // This device's own first-seen time per open order id - there is no
  // venue-reported placement time on `OpenOrder` to show instead, and
  // inventing one would be exactly the kind of fabricated figure the
  // account dock must not show (second design review, item 6/7).
  const [openOrderFirstSeenAtMs, setOpenOrderFirstSeenAtMs] = useState<Record<string, number>>({});

  function appendStep(
    prev: RailStep[],
    type: RailStepType,
    at: number,
    detail?: string,
  ): RailStep[] {
    if (prev.at(-1)?.type === type) return prev;
    return [...prev, { type, at, detail }];
  }

  function updateSession(market: string, updater: (prev: OrderSession) => OrderSession): void {
    setOrderSessions((prev) => {
      const existing = prev[market];
      if (!existing) return prev;
      return { ...prev, [market]: updater(existing) };
    });
  }

  /** Builds the session that a (now-certain) place result settles into, shared between the immediate path below and the pending path's background continuation. */
  function sessionFromResult(
    result: PlacedOrderOutcome["result"],
    descriptor: OrderDescriptor,
    baseSteps: RailStep[],
  ): OrderSession {
    if (result.status === "rejected") {
      return {
        market: descriptor.market,
        descriptor,
        baseSteps: appendStep(
          baseSteps,
          "rejected",
          Date.now(),
          describeRejectReason(result.reason ?? ""),
        ),
        trackedOrderId: null,
        trackedTag: null,
        pendingPlace: null,
      };
    }
    return {
      market: descriptor.market,
      descriptor,
      baseSteps: appendStep(baseSteps, "confirmed", Date.now()),
      trackedOrderId: result.orderId,
      trackedTag: result.tag,
      pendingPlace: null,
    };
  }

  function handleOrderPlaced(outcome: PlacedOrderOutcome, descriptor: OrderDescriptor): void {
    const submittedAt = Date.now() - Math.round(outcome.clientDurationMs);
    const baseSteps: RailStep[] = [{ type: "submitted", at: submittedAt }];
    setClientDurationMs(outcome.clientDurationMs);
    // A filled spot buy is the purchase the trader just watched happen; the
    // dock should already be on Balances so the new holding is on screen
    // without a click, the same courtesy the collateral-to-spot transfer
    // already gets (third design review, must-fix 4).
    const filledStatuses = new Set(["filled", "partiallyFilled"]);
    if (
      marketSettings(descriptor.market)?.kind === "spot" &&
      filledStatuses.has(outcome.result.status)
    ) {
      setDockTab("balances");
    }
    if (outcome.result.pending) {
      const { pending } = outcome.result;
      setOrderSessions((prev) => ({
        ...prev,
        [descriptor.market]: {
          market: descriptor.market,
          descriptor,
          baseSteps: appendStep(baseSteps, "confirmed", Date.now()),
          trackedOrderId: null,
          trackedTag: null,
          pendingPlace: { expiresAtMs: pending.expiresAtMs },
        },
      }));
      void pending.settled.then((settled) => {
        setOrderSessions((prev) => {
          const existing = prev[descriptor.market];
          if (!existing || !existing.pendingPlace) return prev;
          return {
            ...prev,
            [descriptor.market]: sessionFromResult(settled, descriptor, existing.baseSteps),
          };
        });
      });
      return;
    }
    setOrderSessions((prev) => ({
      ...prev,
      [descriptor.market]: sessionFromResult(outcome.result, descriptor, baseSteps),
    }));
  }

  /**
   * Shared by both cancel paths: an immediate result marks the rail
   * cancelled (naming the order id and its remaining size, captured before
   * the cancel so it is still known once the order disappears from state)
   * or shows a plain reason it could not be sent at all (e.g. every
   * order-key slot busy); a pending one shows the countdown and recurses
   * once it settles.
   */
  async function applyCancelOutcome(
    market: string,
    orderId: string | null,
    size: string | null,
    sizeDecimals: number,
    result: CancelResult,
  ): Promise<void> {
    if (result.pending) {
      setCancelPending({ expiresAtMs: result.pending.expiresAtMs });
      const settled = await result.pending.settled;
      setCancelPending(null);
      await applyCancelOutcome(market, orderId, size, sizeDecimals, settled);
      return;
    }
    if (result.cancelled > 0) {
      const detail =
        orderId && size
          ? `Cancelled order ${orderId} · ${formatDecimal(size, sizeDecimals)} remaining.`
          : "Cancelled by request.";
      updateSession(market, (prev) => ({
        ...prev,
        baseSteps: appendStep(prev.baseSteps, "cancelled", Date.now(), detail),
      }));
      return;
    }
    if (result.reason) setCancelMessage(result.reason);
  }

  async function handleCancelAll(): Promise<void> {
    setCancelling(true);
    setCancelMessage(null);
    const open = trading.state.openOrders.find((order) => order.market === selectedMarketId);
    try {
      await applyCancelOutcome(
        selectedMarketId,
        open?.orderId ?? null,
        open?.remainingSize ?? null,
        open ? (marketSettings(open.market) ? sizeDecimalsOf(marketSettings(open.market)!) : 4) : 4,
        await trading.cancelAllInMarket(selectedMarketId),
      );
    } finally {
      setCancelling(false);
    }
  }

  async function handleCancelOrder(market: string, orderId: string): Promise<void> {
    if (!trading.cancelOrder) return;
    setCancelling(true);
    setCancelMessage(null);
    const open = trading.state.openOrders.find((order) => order.orderId === orderId);
    const settings = marketSettings(market);
    try {
      await applyCancelOutcome(
        market,
        orderId,
        open?.remainingSize ?? null,
        settings ? sizeDecimalsOf(settings) : 4,
        await trading.cancelOrder(market, orderId),
      );
    } finally {
      setCancelling(false);
    }
  }

  function requestClose(position: Position): void {
    const size = Number(position.size);
    setSelectedMarketId(position.market);
    setPrefillRequest({
      market: position.market,
      side: size > 0 ? "sell" : "buy",
      size: String(Math.abs(size)),
      reduceOnly: true,
      submit: true,
      requestId: Date.now(),
    });
  }

  function requestReduce(position: Position): void {
    const size = Number(position.size);
    setSelectedMarketId(position.market);
    setPrefillRequest({
      market: position.market,
      side: size > 0 ? "sell" : "buy",
      size: String(Math.abs(size)),
      reduceOnly: true,
      submit: false,
      requestId: Date.now(),
    });
  }

  const market = data.markets.find((item) => item.id === selectedMarketId);
  const mark = data.marksByMarket[selectedMarketId] ?? null;
  // The global connection dot must never say "Live" over a stale selected
  // mark (third design review, must-fix 1): the socket itself can be fully
  // open while sim-noirwire's own price source has gone quiet.
  const markStale = isStale(mark?.time, now, STALE_MARK_MS);
  const tape = data.tapeByMarket[selectedMarketId] ?? [];
  const candles = data.candlesByMarket[selectedMarketId]?.[interval] ?? [];
  const candlesLoading = data.candlesLoading[candlesLoadingKey(selectedMarketId, interval)] ?? true;
  const candlesFetchFailed =
    data.candlesError[candlesLoadingKey(selectedMarketId, interval)] ?? false;

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

  const relevantSession = orderSessions[selectedMarketId] ?? null;
  const trackedOpenOrder = relevantSession?.trackedOrderId
    ? (trading.state.openOrders.find((order) => order.orderId === relevantSession.trackedOrderId) ??
      null)
    : null;
  const trackedFills = relevantSession?.trackedTag
    ? ownFillsForMarket.filter((fill) => fill.tag === relevantSession.trackedTag)
    : [];

  // Review 3, section 3 item 2: while this session's own order rests, the
  // dock shows Open orders without a click, and returns to the trader's own
  // last choice once the order is gone (filled or cancelled). `lastManualTabRef`
  // tracks only tabs the trader picked by hand (via `handleDockTabChange`),
  // never this effect's own auto-switch, so a trader who clicks to Open
  // orders themselves WHILE it rests is still there after it clears - the
  // restore never fights a choice made during the wait, only reverts the
  // one this effect made on the trader's behalf.
  const lastManualTabRef = useRef<Tab>(dockTab);
  const wasRestingRef = useRef(false);
  const handleDockTabChange = useCallback((tab: Tab) => {
    lastManualTabRef.current = tab;
    setDockTab(tab);
  }, []);
  useEffect(() => {
    const resting = !!trackedOpenOrder;
    if (resting && !wasRestingRef.current) {
      setDockTab("openOrders");
    } else if (!resting && wasRestingRef.current) {
      setDockTab(lastManualTabRef.current);
    }
    wasRestingRef.current = resting;
  }, [trackedOpenOrder]);

  // Turns a resting/filled transition into a stable, local-clock step the
  // moment it is first observed - not recomputed every render from a
  // venue-reported timestamp, which was the second design review's
  // "impossible chronology" (Filled showing before Submitted). The venue's
  // own event time is still shown, but separately and labelled, on each
  // fill row in WitnessRail. Syncing this session's own step history to an
  // external signal (trading state arriving from the venue) is the
  // documented case for an effect: it cannot run during render.
  useEffect(() => {
    if (!relevantSession) return;
    const lastStep = relevantSession.baseSteps.at(-1);
    if (trackedOpenOrder) {
      const type: RailStepType =
        Number(trackedOpenOrder.remainingSize) < Number(trackedOpenOrder.size)
          ? "partiallyFilled"
          : "resting";
      if (lastStep?.type !== type) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        updateSession(selectedMarketId, (prev) => ({
          ...prev,
          baseSteps: appendStep(prev.baseSteps, type, Date.now()),
        }));
      }
    } else if (trackedFills.length > 0 && lastStep?.type !== "filled") {
      updateSession(selectedMarketId, (prev) => ({
        ...prev,
        baseSteps: appendStep(prev.baseSteps, "filled", Date.now()),
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackedOpenOrder, trackedFills.length, selectedMarketId]);

  const railSteps: RailStep[] = relevantSession
    ? [
        ...relevantSession.baseSteps,
        ...(relevantSession.pendingPlace
          ? [
              {
                type: "unknown" as RailStepType,
                at: now,
                detail: `Checking with the venue. Do not resend yet. About ${Math.max(0, Math.ceil((relevantSession.pendingPlace.expiresAtMs - now) / 1000))}s.`,
              },
            ]
          : []),
      ]
    : [];

  const openOrderIdsKey = trading.state.openOrders
    .map((order) => order.orderId)
    .sort()
    .join(",");
  useEffect(() => {
    const ids = new Set(trading.state.openOrders.map((order) => order.orderId));
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpenOrderFirstSeenAtMs((prev) => {
      const next: Record<string, number> = {};
      let changed = ids.size !== Object.keys(prev).length;
      for (const id of ids) {
        if (prev[id] !== undefined) {
          next[id] = prev[id];
        } else {
          next[id] = Date.now();
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openOrderIdsKey]);

  // A small cross-market "recent activity" control: every other market
  // this session placed an order in, most recent first.
  const recentMarkets: RecentMarketActivity[] = Object.values(orderSessions)
    .filter((session) => session.market !== selectedMarketId)
    .sort((a, b) => (b.baseSteps.at(-1)?.at ?? 0) - (a.baseSteps.at(-1)?.at ?? 0))
    .map((session) => ({
      market: session.market,
      summary: RailStepSummary(session.baseSteps.at(-1)?.type),
    }));
  // The account shows positions or fills this session's own order sessions
  // do not explain - almost always a reload. Drives the rail's "this
  // session only" copy instead of a bare empty prompt (item 5).
  const hasAccountHistory =
    Object.keys(orderSessions).length === 0 &&
    (positionsArray.some((p) => Number(p.size) !== 0) || ownFillsForMarket.length > 0);

  const statusBarText = market
    ? `${market.id} · ${env.networkLabel} · last data ${mark ? formatClockTime(new Date(mark.time)) : "unavailable"} · account ${wallet.account ? (trading.lastSyncedAtMs ? `synced at ${formatClockTime(new Date(trading.lastSyncedAtMs))}` : "not yet synced") : "no wallet"}`
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
      onFund={() => trading.fund()}
      grantAlreadyUsed={trading.grantUsed}
      placeOrder={trading.placeOrder}
      onOrderPlaced={handleOrderPlaced}
      onTransferToSpot={
        trading.transferBetweenBalances
          ? async (toSpot, amount) => {
              const result = await trading.transferBetweenBalances!(toSpot, amount);
              // A spot buy is what the trader is about to do right after
              // this transfer completes; the dock should already be ready
              // on Balances so the new holding is visible as soon as it
              // lands, not left on whatever tab happened to be open.
              if (result.kind === "ok" && toSpot) setDockTab("balances");
              return result;
            }
          : null
      }
      supportsGoodFor={trading.client.mode === "rollup"}
      placeOrderPending={!!relevantSession?.pendingPlace}
      prefillRequest={prefillRequest}
      compact={!isDesktop}
    />
  );

  const witnessRail = (
    <WitnessRail
      market={selectedMarketId}
      order={relevantSession?.descriptor ?? null}
      steps={railSteps}
      openOrder={trackedOpenOrder}
      ownFills={trackedFills}
      clientDurationMs={clientDurationMs}
      network={network}
      recentMarkets={recentMarkets}
      onSelectMarket={setSelectedMarketId}
      hasAccountHistory={hasAccountHistory}
      onViewFills={() => setDockTab("fills")}
      onCancelAll={() => void handleCancelAll()}
      onCancelOrder={
        trading.cancelOrder && trackedOpenOrder
          ? () => void handleCancelOrder(selectedMarketId, trackedOpenOrder.orderId)
          : null
      }
      cancelling={cancelling}
      cancelPending={cancelPending}
      cancelMessage={cancelMessage}
      now={now}
    />
  );

  const accountDock = (
    <AccountDock
      tab={dockTab}
      onTabChange={handleDockTabChange}
      positions={positionsArray}
      openOrders={trading.state.openOrders}
      openOrderFirstSeenAtMs={openOrderFirstSeenAtMs}
      ownFills={ownFillsForMarket}
      balances={balancesArray}
      collateral={trading.state.collateral ?? null}
      marketSettings={marketSettings}
      marksByMarket={data.marksByMarket}
      now={now}
      hasWallet={!!wallet.account}
      onTransfer={trading.transferBetweenBalances}
      onClosePosition={requestClose}
      onReducePosition={requestReduce}
      onCancelOrder={trading.cancelOrder ? (m, id) => void handleCancelOrder(m, id) : null}
      cancellingOrderId={cancelling ? (trackedOpenOrder?.orderId ?? null) : null}
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
              interval={interval}
              candles={candles}
              mark={mark}
              publicFills={tape}
              ownSequences={ownSequences}
              connectionState={data.connectionState}
              loading={candlesLoading}
              fetchFailed={candlesFetchFailed}
              markStale={markStale}
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
            <VenuePulse
              stats={data.stats}
              now={now}
              network={network}
              clientDurationMs={clientDurationMs}
            />
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
    <PhoneLayout
      market={market}
      mark={mark}
      now={now}
      markets={data.markets}
      selectedMarketId={selectedMarketId}
      onSelectMarket={setSelectedMarketId}
      phoneView={phoneView}
      onPhoneViewChange={setPhoneView}
      orderEntry={orderEntry}
      witnessRail={witnessRail}
      accountDock={accountDock}
      interval={interval}
      candles={candles}
      tape={tape}
      ownSequences={ownSequences}
      connectionState={data.connectionState}
      candlesLoading={candlesLoading}
      candlesFetchFailed={candlesFetchFailed}
      onRetry={() => setRetryToken((token) => token + 1)}
      stats={data.stats}
      network={network}
      checkPrivacy={trading.checkPrivacy}
      markStale={markStale}
      clientDurationMs={clientDurationMs}
    />
  );

  return (
    <TerminalShell
      connectionState={data.connectionState}
      marketDataStale={markStale}
      wallet={wallet}
      statusBarText={statusBarText}
    >
      {content}
    </TerminalShell>
  );
}

function RailStepSummary(type: RailStepType | undefined): string {
  switch (type) {
    case "filled":
      return "filled";
    case "resting":
      return "resting";
    case "partiallyFilled":
      return "partial fill";
    case "cancelled":
      return "cancelled";
    case "rejected":
      return "rejected";
    case "unknown":
      return "checking";
    default:
      return "placed";
  }
}

/**
 * Phone layout: a 48 px sticky bar (market, side, quantity, status, the
 * primary action) always visible, with the first viewport showing side,
 * quantity, available balance and the action together - the second design
 * review's item 10. Secondary evidence (chart, tape, pulse, public view)
 * collapses behind the "Market" toggle, same as before.
 */
function PhoneLayout({
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
  interval,
  candles,
  tape,
  ownSequences,
  connectionState,
  candlesLoading,
  candlesFetchFailed,
  onRetry,
  stats,
  now,
  network,
  checkPrivacy,
  markStale,
  clientDurationMs,
}: {
  market: MarketInfo | undefined;
  mark: { price: string; time: number } | null;
  now: number;
  markets: MarketInfo[];
  selectedMarketId: string;
  onSelectMarket: (market: string) => void;
  phoneView: "trade" | "market";
  onPhoneViewChange: (view: "trade" | "market") => void;
  orderEntry: React.ReactNode;
  witnessRail: React.ReactNode;
  accountDock: React.ReactNode;
  interval: CandleInterval;
  candles: Candle[];
  tape: PublicFill[];
  ownSequences: ReadonlySet<number>;
  connectionState: ConnectionState;
  candlesLoading: boolean;
  candlesFetchFailed: boolean;
  onRetry: () => void;
  stats: StatsResponse | null;
  network: string;
  checkPrivacy: ReturnType<typeof useTrading>["checkPrivacy"];
  markStale: boolean;
  clientDurationMs: number | null;
}) {
  const priceDecimals = market ? priceDecimalsOf(market) : 2;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
      {/* The 48 px sticky bar: market, mark, change, always visible. */}
      <div className="bg-surface border-line-subtle rounded-panel sticky top-0 z-10 flex h-12 shrink-0 items-center justify-between px-3 text-[13px]">
        <span className="text-ink-strong font-medium">{market?.id ?? ""}</span>
        <span className="tnum flex items-center gap-2">
          <span className="text-ink">
            {mark ? formatDecimal(mark.price, priceDecimals) : "Unavailable"}
          </span>
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
      <div className="flex gap-2" role="group" aria-label="View">
        <button
          type="button"
          aria-pressed={phoneView === "trade"}
          onClick={() => onPhoneViewChange("trade")}
          className={`rounded-tile min-h-11 flex-1 text-[13px] ${phoneView === "trade" ? "bg-elevated text-ink-strong" : "text-dim"}`}
        >
          Trade
        </button>
        <button
          type="button"
          aria-pressed={phoneView === "market"}
          onClick={() => onPhoneViewChange("market")}
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
          <PublicTape
            fills={tape}
            priceDecimals={market ? priceDecimalsOf(market) : 2}
            sizeDecimals={market ? sizeDecimalsOf(market) : 4}
            ownSequences={ownSequences}
          />
          <VenuePulse
            stats={stats}
            now={now}
            network={network}
            clientDurationMs={clientDurationMs}
          />
          <PublicView market={selectedMarketId} checkPrivacy={checkPrivacy} />
        </div>
      )}
    </div>
  );
}
