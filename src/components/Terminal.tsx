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
import { fetchDeployment, quoteSymbolOf, type PublicDeployment } from "@/lib/rollup/deployment";
import { describeRejectReason } from "@/lib/trading/validation";
import { useNow } from "@/components/hooks/useNow";
import { useMediaQuery } from "@/components/hooks/useMediaQuery";
import { TerminalShell } from "@/components/TerminalShell";
import { DesktopWorkspace } from "@/components/DesktopWorkspace";
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
import { holdClearableAtMs, type UnknownHold } from "@/lib/rollup/accountMemory";
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
   * A null `expiresAtMs` is an order that may have reached the venue with no
   * way to learn its result: it holds the form until one of its own fills is
   * seen, or the trader clears it after checking.
   */
  pendingPlace: { expiresAtMs: number | null; clearableAtMs?: number } | null;
}

/** An order session belongs to one wallet and one market: another wallet's never shows, blocks or clears this one's. */
function sessionKey(owner: string, market: string): string {
  return `${owner}:${market}`;
}

export function Terminal() {
  const store = useSharedMarketDataStore();
  const [chosenMarketId, setChosenMarketId] = useState<string>(MARKET_IDS[0]);
  const [interval, setInterval] = useState<CandleInterval>("1m");
  const [retryToken, setRetryToken] = useState(0);
  const data = useMarketDataState(store);
  // A deployment may list fewer markets than this build knows: once the
  // list has loaded, a choice it does not hold falls back to its first.
  const selectedMarketId =
    data.markets.length > 0 && !data.markets.some((item) => item.id === chosenMarketId)
      ? data.markets[0].id
      : chosenMarketId;
  useMarketDataConnection(store, env.simUrl, env.simWsUrl, selectedMarketId, interval, retryToken);
  const now = useNow();
  const isDesktop = useMediaQuery("(min-width: 900px)");
  const [layoutResetSignal, setLayoutResetSignal] = useState(0);
  const [phoneView, setPhoneView] = useState<"trade" | "market">("trade");
  const [dockTab, setDockTab] = useState<Tab>("positions");

  const wallet = useWallet();
  const owner = wallet.account?.publicKey ?? "";
  const marketSettings = useCallback(
    (id: string) => data.markets.find((item) => item.id === id),
    [data.markets],
  );
  // The trading client, its sign-in and its websocket live once per wallet:
  // this lookup reads the store, so it never changes identity, and trading
  // starts only once the market list it binds against has loaded.
  const marketSettingsFromStore = useCallback(
    (id: string) => store.getState().markets.find((item) => item.id === id),
    [store],
  );
  const marketsLoaded = data.markets.length > 0;
  const trading = useTrading(marketsLoaded ? wallet.account : null, marketSettingsFromStore);

  // Dev mode is always an in-memory, same-process engine - "localnet" in
  // spirit regardless of label. Rollup mode reads the real value from
  // sim-noirwire's own deployment description (no wallet needed; this is
  // the same cached fetch `RollupTradingClient` makes once a wallet
  // exists), so a speed figure never claims "local" for a public network
  // or vice versa (second design review, item 3).
  const [deployment, setDeployment] = useState<PublicDeployment | null>(null);
  useEffect(() => {
    if (trading.client.mode !== "rollup") return;
    let cancelled = false;
    fetchDeployment(env.simUrl)
      .then((described) => {
        if (!cancelled) setDeployment(described);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [trading.client.mode]);
  const network = deployment?.network ?? "localnet";

  // One session per market, not one session total: switching markets must
  // not erase what happened in another one (second design review, item 5).
  const [orderSessions, setOrderSessions] = useState<Record<string, OrderSession>>({});
  const [clientDurationMs, setClientDurationMs] = useState<number | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelPending, setCancelPending] = useState<{ expiresAtMs: number } | null>(null);
  const [cancelMessage, setCancelMessage] = useState<string | null>(null);
  const [prefillRequest, setPrefillRequest] = useState<PrefillRequest | null>(null);
  const syncedMakerFillsRef = useRef(new Set<string>());
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
    const key = sessionKey(owner, market);
    setOrderSessions((prev) => {
      const existing = prev[key];
      if (!existing) return prev;
      return { ...prev, [key]: updater(existing) };
    });
  }

  /**
   * Dev mode's reasons are the venue's own short codes, translated here;
   * rollup mode's are already plain sentences (rollup/outcome.ts), shown
   * as they are rather than wrapped in a second sentence.
   */
  function rejectionDetail(reason: string | null): string {
    if (trading.client.mode === "rollup" && reason) return reason;
    return describeRejectReason(reason ?? "");
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
        baseSteps: appendStep(baseSteps, "rejected", Date.now(), rejectionDetail(result.reason)),
        trackedOrderId: null,
        trackedTag: null,
        pendingPlace: null,
      };
    }
    const confirmedSteps = appendStep(baseSteps, "confirmed", Date.now());
    if (result.status === "cancelled") {
      return {
        market: descriptor.market,
        descriptor,
        baseSteps: appendStep(
          confirmedSteps,
          "cancelled",
          Date.now(),
          `Nothing filled. ${result.reason ?? "The order did not match and was cancelled."}`,
        ),
        trackedOrderId: null,
        trackedTag: null,
        pendingPlace: null,
      };
    }
    return {
      market: descriptor.market,
      descriptor,
      // The venue's own result already says the order filled; the rail does
      // not wait for the public tape to say it again.
      baseSteps:
        result.status === "filled"
          ? appendStep(confirmedSteps, "filled", Date.now())
          : confirmedSteps,
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
      const key = sessionKey(owner, descriptor.market);
      setOrderSessions((prev) => ({
        ...prev,
        [key]: {
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
          const existing = prev[key];
          if (!existing || !existing.pendingPlace) return prev;
          return {
            ...prev,
            [key]: sessionFromResult(settled, descriptor, existing.baseSteps),
          };
        });
      });
      return;
    }
    setOrderSessions((prev) => ({
      ...prev,
      [sessionKey(owner, descriptor.market)]: sessionFromResult(
        outcome.result,
        descriptor,
        baseSteps,
      ),
    }));
  }

  function heldSession(descriptor: OrderDescriptor, hold: UnknownHold): OrderSession {
    return {
      market: descriptor.market,
      descriptor,
      baseSteps: [{ type: "submitted", at: hold.sentAtMs }],
      trackedOrderId: null,
      trackedTag: hold.tag,
      pendingPlace: { expiresAtMs: null, clearableAtMs: holdClearableAtMs(hold) },
    };
  }

  function handleOrderUnknown(descriptor: OrderDescriptor, hold: UnknownHold): void {
    setOrderSessions((prev) => ({
      ...prev,
      [sessionKey(owner, descriptor.market)]: heldSession(descriptor, hold),
    }));
  }

  /** Releases only the hold this wallet's shown record names (its market and tag), and clears only that record. */
  function clearUnknownHold(market: string): void {
    const shown = orderSessions[sessionKey(owner, market)];
    if (!shown?.trackedTag || shown.pendingPlace?.clearableAtMs === undefined) return;
    trading.releaseUnknownOutcome(market, shown.trackedTag);
    updateSession(market, (prev) => ({ ...prev, pendingPlace: null }));
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
    setChosenMarketId(position.market);
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
    setChosenMarketId(position.market);
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
  // Rollup mode names the quote token as the deployment does (USDC, nUSD),
  // never as /v1/markets' own label; until that description has loaded,
  // amounts show without a name rather than with a guessed one.
  const quoteSymbol =
    trading.client.mode === "rollup"
      ? deployment
        ? (quoteSymbolOf(deployment, selectedMarketId) ?? "")
        : ""
      : (market?.quote ?? "");
  // A held order survives a reload: its record is read back from storage so
  // the form for that market is still locked, with the order shown on the rail.
  const readUnknownOutcome = trading.readUnknownOutcome;
  useEffect(() => {
    const settings = marketSettings(selectedMarketId);
    if (!settings) return;
    let active = true;
    const holder = owner;
    void readUnknownOutcome(selectedMarketId).then((hold) => {
      if (!active || !hold || !holder) return;
      const descriptor: OrderDescriptor = {
        market: hold.market,
        side: hold.side,
        type: hold.type,
        price: hold.price,
        size: hold.size,
        kind: settings.kind,
        baseUnit: trading.state.spotAssets?.[hold.market]?.base ?? settings.base,
        quoteUnit: quoteSymbol,
        priceDecimals: priceDecimalsOf(settings),
        sizeDecimals: sizeDecimalsOf(settings),
      };
      const key = sessionKey(holder, hold.market);
      setOrderSessions((prev) =>
        prev[key]?.pendingPlace ? prev : { ...prev, [key]: heldSession(descriptor, hold) },
      );
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readUnknownOutcome, selectedMarketId, marketsLoaded, owner]);
  // Moving funds between collateral and spot only means something where a
  // spot market exists to spend them on.
  const hasSpotMarket = data.markets.some((item) => item.kind === "spot");
  const transferBetweenBalances = hasSpotMarket ? trading.transferBetweenBalances : null;
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

  // Rollup mode: a fill a resting order receives from someone else's taker
  // order does not reach this trader's view until `sync_view` runs (see
  // TradingClient.syncMarket). A fill this trader took needs none: the
  // order's own instruction already wrote it.
  const { syncMarket } = trading;
  const makerFillSequences = ownFillsForMarket
    .filter((fill) => fill.role === "maker")
    .map((fill) => fill.sequence)
    .join(",");
  useEffect(() => {
    const synced = syncedMakerFillsRef.current;
    const unsynced = makerFillSequences.split(",").filter((seq) => seq && !synced.has(seq));
    if (unsynced.length === 0) return;
    for (const sequence of unsynced) synced.add(sequence);
    void syncMarket(selectedMarketId);
  }, [makerFillSequences, selectedMarketId, syncMarket]);

  const relevantSession = orderSessions[sessionKey(owner, selectedMarketId)] ?? null;
  const ownSessions = Object.entries(orderSessions)
    .filter(([key]) => key.startsWith(`${owner}:`))
    .map(([, session]) => session);
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
      if (relevantSession.pendingPlace?.expiresAtMs === null) {
        // One of its own fills proves the held order ran.
        trading.releaseUnknownOutcome(selectedMarketId, relevantSession.trackedTag ?? undefined);
      }
      updateSession(selectedMarketId, (prev) => ({
        ...prev,
        pendingPlace: prev.pendingPlace?.expiresAtMs === null ? null : prev.pendingPlace,
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
                detail:
                  relevantSession.pendingPlace.expiresAtMs === null
                    ? "Outcome unknown. Check open orders and positions before retrying; the order form stays locked until then."
                    : `Checking with the venue. Do not resend yet. About ${Math.max(0, Math.ceil((relevantSession.pendingPlace.expiresAtMs - now) / 1000))}s.`,
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
  const recentMarkets: RecentMarketActivity[] = ownSessions
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
    ownSessions.length === 0 &&
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
      walletLocked={!!wallet.lockedAddress}
      balances={trading.state.balances}
      collateral={trading.state.collateral}
      accountError={trading.accountError}
      accountLoaded={trading.accountLoaded}
      onOrderUnknown={handleOrderUnknown}
      unknownHold={
        relevantSession?.pendingPlace?.clearableAtMs !== undefined
          ? { clearableAtMs: relevantSession.pendingPlace.clearableAtMs }
          : null
      }
      onClearUnknownHold={() => clearUnknownHold(market.id)}
      position={position}
      onCreateWallet={() => wallet.create()}
      onFund={() => trading.fund()}
      grantAlreadyUsed={trading.grantUsed}
      noFaucet={trading.noFaucet}
      quoteSymbol={quoteSymbol}
      placeOrder={trading.placeOrder}
      onOrderPlaced={handleOrderPlaced}
      onTransferToSpot={
        transferBetweenBalances
          ? async (toSpot, amount) => {
              const result = await transferBetweenBalances(toSpot, amount);
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
      spotAssets={trading.state.spotAssets?.[market.id]}
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
      onSelectMarket={setChosenMarketId}
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
      quoteSymbol={quoteSymbol}
      onTransfer={transferBetweenBalances}
      onClosePosition={requestClose}
      onReducePosition={requestReduce}
      onCancelOrder={trading.cancelOrder ? (m, id) => void handleCancelOrder(m, id) : null}
      cancellingOrderId={cancelling ? (trackedOpenOrder?.orderId ?? null) : null}
      bordered={!isDesktop}
    />
  );

  const content = isDesktop ? (
    <DesktopWorkspace
      layoutResetSignal={layoutResetSignal}
      market={market}
      mark={mark}
      now={now}
      quoteSymbol={quoteSymbol}
      interval={interval}
      onIntervalChange={setInterval}
      candles={candles}
      tape={tape}
      ownSequences={ownSequences}
      connectionState={data.connectionState}
      candlesLoading={candlesLoading}
      candlesFetchFailed={candlesFetchFailed}
      markStale={markStale}
      onRetry={() => setRetryToken((token) => token + 1)}
      markets={data.markets}
      selectedMarketId={selectedMarketId}
      onSelectMarket={setChosenMarketId}
      stats={data.stats}
      network={network}
      clientDurationMs={clientDurationMs}
      witnessRail={witnessRail}
      checkPrivacy={trading.checkPrivacy}
      orderEntry={orderEntry}
      accountDock={accountDock}
    />
  ) : (
    <PhoneLayout
      market={market}
      mark={mark}
      now={now}
      markets={data.markets}
      selectedMarketId={selectedMarketId}
      onSelectMarket={setChosenMarketId}
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
      onResetLayout={isDesktop ? () => setLayoutResetSignal((signal) => signal + 1) : undefined}
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
