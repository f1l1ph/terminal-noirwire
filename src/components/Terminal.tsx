"use client";

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { env } from "@/lib/env";
import { MARKET_IDS } from "@/lib/market-data/types";
import type { CandleInterval } from "@/lib/market-data/types";
import {
  useMarketDataConnection,
  useMarketDataState,
  useSharedMarketDataStore,
} from "@/lib/market-data/hooks";
import {
  candlesLoadingKey,
  isStale,
  marketsWithNewerMark,
  marketWithLiveMark,
  STALE_MARK_MS,
} from "@/lib/market-data/selectors";
import { isMainnetBuild } from "@/lib/network";
import { useOwnerIdentity } from "@/lib/wallet/useOwnerIdentity";
import { useWallet } from "@/lib/wallet/useWallet";
import {
  useTrading,
  type PlacedOrderOutcome,
  type SubscribeNewerMarks,
} from "@/lib/trading/useTrading";
import { deploymentOverrides } from "@/lib/trading";
import type { CancelResult, Position } from "@/lib/trading/types";
import { deriveOwnFills, type OwnFillRecord } from "@/lib/trading/tags";
import { withoutSign } from "@/lib/trading/decimal";
import type { LimitLine } from "@/lib/trading/limitLine";
import { deriveRollupOwnFills } from "@/lib/rollup/ownFills";
import { syncUntilDone } from "@/lib/trading/fillSync";
import {
  expiringOrders,
  ordersPastExpiry,
  shouldReadRollupClock,
} from "@/lib/trading/expiredOrders";
import { UNCONFIRMED_PLACE_RESULT } from "@/lib/rollup/outcome";
import { fetchDeployment, quoteSymbolOf, type PublicDeployment } from "@/lib/rollup/deployment";
import { describeRejectReason } from "@/lib/trading/validation";
import { offersSpotTrading, tradeGate } from "@/lib/trading/uiRules";
import { AccountSetup } from "@/components/AccountSetup";
import { useNow } from "@/components/hooks/useNow";
import { useMediaQuery } from "@/components/hooks/useMediaQuery";
import { useTradingTabGuard } from "@/components/hooks/useTradingTabGuard";
import { useTradingPause } from "@/components/hooks/useTradingPause";
import { usePrivacyTools } from "@/components/hooks/usePrivacyTools";
import { OrderNotice } from "@/components/OrderNotice";
import { PrivacyToolsToggle } from "@/components/PrivacyToolsToggle";
import { TerminalShell } from "@/components/TerminalShell";
import { TerminalNotices, TRADING_IN_OTHER_TAB_NOTICE } from "@/components/TerminalNotices";
import { DesktopWorkspace } from "@/components/DesktopWorkspace";
import { PhoneLayout, type PhoneView } from "@/components/PhoneLayout";
import {
  WitnessRail,
  type OrderDescriptor,
  type RailStep,
  type RailStepType,
  type RecentMarketActivity,
} from "@/components/WitnessRail";
import { OrderEntry, type PrefillRequest } from "@/components/OrderEntry";
import { AccountDock, type Tab } from "@/components/AccountDock";
import { TransferRecords } from "@/components/TransferRecords";
import { holdClearableAtMs, type UnknownHold } from "@/lib/rollup/accountMemory";
import { formatClockTime, formatDecimal } from "@/lib/format";
import { userMessageLine } from "@/lib/userMessage";
import { priceDecimalsOf, sizeDecimalsOf } from "@/lib/market-data/precision";

/**
 * The deposit and withdraw controls and everything they move money with. The
 * literal comparison lets the build drop the import when the switch is off,
 * so such a build ships none of the transfer code.
 */
const FundsSection =
  process.env.NEXT_PUBLIC_DEPOSITS === "on"
    ? lazy(() => import("@/components/FundsSection"))
    : null;

const CANDLE_INTERVAL: CandleInterval = "1m";

/** An order the rollup's clock does not yet call expired, or a clock reading that failed, is looked at again after this long. */
const EXPIRY_RECHECK_MS = 5_000;

/** While an order that expires is open, the check for expiry is looked at this often; a fresh clock reading is taken at most every 30 seconds. */
const EXPIRY_TICK_MS = 10_000;

/** Opens the message shown when cancelling an expired order on the trader's behalf did not go through. */
const EXPIRED_CANCEL_FAILURE_LEAD = "An order of yours expired and could not be cancelled. ";

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
  const allData = useMarketDataState(store);
  // Only the perpetual is launched on mainnet: spot markets are not listed at all.
  const data = useMemo(
    () =>
      offersSpotTrading(isMainnetBuild())
        ? allData
        : { ...allData, markets: allData.markets.filter((item) => item.kind === "perp") },
    [allData],
  );
  // A deployment may list fewer markets than this build knows: once the
  // list has loaded, a choice it does not hold falls back to its first.
  const selectedMarketId =
    data.markets.length > 0 && !data.markets.some((item) => item.id === chosenMarketId)
      ? data.markets[0].id
      : chosenMarketId;
  useMarketDataConnection(store, env.simUrl, env.simWsUrl, selectedMarketId, CANDLE_INTERVAL);
  const now = useNow();
  const isDesktop = useMediaQuery("(min-width: 900px)");
  const [layoutResetSignal, setLayoutResetSignal] = useState(0);
  const [phoneView, setPhoneView] = useState<PhoneView>("trade");
  const [limitLine, setLimitLine] = useState<LimitLine | null>(null);
  const mainnet = isMainnetBuild();
  const [privacyTools] = usePrivacyTools();
  const toolsOn = !mainnet || privacyTools;
  const [dockTab, setDockTab] = useState<Tab>("positions");

  const wallet = useWallet();
  const ownerIdentity = useOwnerIdentity(wallet);
  const owner = ownerIdentity?.address ?? "";
  const tabGuard = useTradingTabGuard(owner || null);
  const tradingPause = useTradingPause(env.simUrl);
  const marketSettings = useCallback(
    (id: string) => data.markets.find((item) => item.id === id),
    [data.markets],
  );
  // The trading client, its sign-in and its websocket live once per wallet:
  // this lookup reads the store, so it never changes identity, and trading
  // starts only once the market list it binds against has loaded.
  const marketSettingsFromStore = useCallback(
    (id: string) => {
      const state = store.getState();
      return marketWithLiveMark(state.markets, state.marksByMarket, id);
    },
    [store],
  );
  const marketsLoaded = data.markets.length > 0;
  const subscribeNewerMarks = useCallback<SubscribeNewerMarks>(
    (onNewer) => {
      let seen = store.getState().marksByMarket;
      return store.subscribe(() => {
        const current = store.getState().marksByMarket;
        if (current === seen) return;
        const newer = marketsWithNewerMark(seen, current);
        seen = current;
        if (newer.length > 0) onNewer(newer);
      });
    },
    [store],
  );
  const trading = useTrading(
    marketsLoaded ? ownerIdentity : null,
    marketSettingsFromStore,
    subscribeNewerMarks,
  );

  // Dev mode is always an in-memory, same-process engine - "localnet" in
  // spirit regardless of label. Rollup mode reads the real value from
  // sim-noirwire's own deployment description (no wallet needed; this is
  // the same cached fetch `RollupTradingClient` makes once a wallet
  // exists), so a speed figure never claims "local" for a public network
  // or vice versa (second design review, item 3).
  // The session's own deployment wins once it exists, and so is retried with
  // the session; this one fetch only covers the time before a wallet connects.
  const [fetchedDeployment, setFetchedDeployment] = useState<PublicDeployment | null>(null);
  useEffect(() => {
    if (trading.client.mode !== "rollup") return;
    let cancelled = false;
    fetchDeployment(env.simUrl, deploymentOverrides)
      .then((described) => {
        if (!cancelled) setFetchedDeployment(described);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [trading.client.mode]);
  const deployment = trading.sessionDeployment ?? fetchedDeployment;
  const network = deployment?.network ?? (mainnet ? "mainnet" : "localnet");

  // One session per market, not one session total: switching markets must
  // not erase what happened in another one (second design review, item 5).
  const [orderSessions, setOrderSessions] = useState<Record<string, OrderSession>>({});
  const [clientDurationMs, setClientDurationMs] = useState<number | null>(null);
  const [cancelling, setCancelling] = useState(false);
  /** Ids of the resting orders whose own cancel is running; each row's cancel is off by its own id. */
  const [cancellingIds, setCancellingIds] = useState<ReadonlySet<string>>(new Set());
  const [cancelPending, setCancelPending] = useState<{ expiresAtMs: number } | null>(null);
  const [cancelMessage, setCancelMessage] = useState<string | null>(null);
  const [prefillRequest, setPrefillRequest] = useState<PrefillRequest | null>(null);
  const syncedMakerFillsRef = useRef(new Set<string>());

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
          result.reason ?? "Nothing filled. The order did not match and was cancelled.",
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
      const settleSession = (settled: PlacedOrderOutcome["result"]) =>
        setOrderSessions((prev) => {
          const existing = prev[key];
          if (!existing || !existing.pendingPlace) return prev;
          return {
            ...prev,
            [key]: sessionFromResult(settled, descriptor, existing.baseSteps),
          };
        });
      void pending.settled.then(settleSession).catch(() => settleSession(UNCONFIRMED_PLACE_RESULT));
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
   * once it settles. A cancel of one order marks the rail only when that
   * order is the one the rail tracks; a cancel of every order in the market
   * always does.
   */
  async function applyCancelOutcome(
    market: string,
    orderId: string | null,
    size: string | null,
    sizeDecimals: number,
    result: CancelResult,
    singleOrder: boolean,
    failureLead = "",
  ): Promise<void> {
    if (result.pending) {
      setCancelPending({ expiresAtMs: result.pending.expiresAtMs });
      const settled = await result.pending.settled;
      setCancelPending(null);
      await applyCancelOutcome(
        market,
        orderId,
        size,
        sizeDecimals,
        settled,
        singleOrder,
        failureLead,
      );
      return;
    }
    if (result.cancelled > 0) {
      const detail =
        orderId && size
          ? `Cancelled order ${orderId} · ${formatDecimal(size, sizeDecimals)} remaining.`
          : "Cancelled by request.";
      updateSession(market, (prev) =>
        singleOrder && prev.trackedOrderId !== orderId
          ? prev
          : {
              ...prev,
              baseSteps: appendStep(prev.baseSteps, "cancelled", Date.now(), detail),
            },
      );
      return;
    }
    if (result.reason) setCancelMessage(`${failureLead}${result.reason}`);
  }

  async function handleCancelAll(): Promise<void> {
    if (tabGuard.elsewhere) {
      setCancelMessage(TRADING_IN_OTHER_TAB_NOTICE);
      return;
    }
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
        false,
      );
    } catch (error) {
      setCancelPending(null);
      setCancelMessage(userMessageLine(error, { nothingSent: true }));
    } finally {
      setCancelling(false);
    }
  }

  async function handleCancelOrder(
    market: string,
    orderId: string,
    failureLead = "",
  ): Promise<void> {
    if (!trading.cancelOrder || cancellingIds.has(orderId)) return;
    if (tabGuard.elsewhere) {
      setCancelMessage(TRADING_IN_OTHER_TAB_NOTICE);
      return;
    }
    setCancellingIds((prev) => new Set(prev).add(orderId));
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
        true,
        failureLead,
      );
    } catch (error) {
      setCancelPending(null);
      setCancelMessage(`${failureLead}${userMessageLine(error, { nothingSent: true })}`);
    } finally {
      setCancellingIds((prev) => {
        const next = new Set(prev);
        next.delete(orderId);
        return next;
      });
    }
  }

  function requestReduceOnly(position: Position, submit: boolean): void {
    setChosenMarketId(position.market);
    setPrefillRequest({
      market: position.market,
      side: position.size.trim().startsWith("-") ? "buy" : "sell",
      size: withoutSign(position.size),
      reduceOnly: true,
      submit,
      requestId: Date.now(),
    });
  }

  const requestClose = (position: Position): void => requestReduceOnly(position, true);
  const requestReduce = (position: Position): void => requestReduceOnly(position, false);

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
  // The connection dot reports the socket only; the price header shows how
  // old the price is.
  const markStale = isStale(mark?.time, now, STALE_MARK_MS);
  const tape = data.tapeByMarket[selectedMarketId] ?? [];
  const candles = data.candlesByMarket[selectedMarketId]?.[CANDLE_INTERVAL] ?? [];
  const candlesLoading =
    data.candlesLoading[candlesLoadingKey(selectedMarketId, CANDLE_INTERVAL)] ?? true;

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
  // Either sync below is asked again, ever more slowly up to once a minute,
  // for as long as the account is open and it has not gone through.
  const accountOpen = trading.accountStatus === "open" && trading.accountLoaded;
  useEffect(() => {
    const synced = syncedMakerFillsRef.current;
    const unsynced = makerFillSequences.split(",").filter((seq) => seq && !synced.has(seq));
    if (!accountOpen || unsynced.length === 0) return;
    return syncUntilDone(
      () => syncMarket(selectedMarketId),
      () => {
        for (const sequence of unsynced) synced.add(sequence);
      },
    );
  }, [accountOpen, makerFillSequences, selectedMarketId, syncMarket]);

  // A fill that landed while this page was closed shows only after a sync, and
  // no fill seen on the tape prompts one: sync once when the account loads.
  const sessionSyncedRef = useRef(new Set<string>());
  useEffect(() => {
    const key = sessionKey(owner, selectedMarketId);
    if (!owner || !accountOpen || sessionSyncedRef.current.has(key)) return;
    return syncUntilDone(
      () => syncMarket(selectedMarketId),
      () => sessionSyncedRef.current.add(key),
    );
  }, [owner, accountOpen, selectedMarketId, syncMarket]);

  // The program removes an expired resting order only when a crossing order
  // reaches it, so until then it still holds its margin, its share of the
  // position limit and one of the open-order slots. Once the rollup's own
  // clock is past its expiry the order is cancelled with the order key (no
  // wallet prompt), once per order; a failure is shown and not repeated.
  // Without a reading of that clock nothing is cancelled: this device's
  // clock alone could end a live order early.
  const expiryNow = now + (trading.clockOffsetMs ?? 0);
  const expiredOrderIds =
    trading.clockOffsetMs === null
      ? ""
      : trading.state.openOrders
          .filter((order) => typeof order.expiresAtMs === "number" && expiryNow > order.expiresAtMs)
          .map((order) => `${order.market}:${order.orderId}`)
          .join(",");
  const autoCancelledRef = useRef(new Set<string>());
  const [expiryRecheck, setExpiryRecheck] = useState(0);
  const { rollupNowMs } = trading;
  const expiringIds = expiringOrders(trading.state.openOrders)
    .map((order) => `${order.market}:${order.orderId}`)
    .join(",");
  const lastExpiryReadRef = useRef(0);
  const [expiryTick, setExpiryTick] = useState(0);
  useEffect(() => {
    if (!expiringIds) return;
    const timer = setInterval(() => setExpiryTick((count) => count + 1), EXPIRY_TICK_MS);
    return () => clearInterval(timer);
  }, [expiringIds]);
  useEffect(() => {
    if (!owner || !expiringIds || tabGuard.elsewhere || !trading.cancelOrder) return;
    // The offset estimate can be wrong in either direction (a device clock that
    // moved since it was measured), so with any expiring order open the rollup's
    // clock is read now and then whatever the estimate says; an order the
    // estimate already calls expired is looked at sooner.
    const flagged = expiredOrderIds
      ? expiredOrderIds.split(",").filter((id) => !autoCancelledRef.current.has(`${owner}:${id}`))
      : [];
    const readNow = shouldReadRollupClock({
      estimateFlagsExpired: flagged.length > 0,
      lastReadMs: lastExpiryReadRef.current,
      nowMs: Date.now(),
    });
    if (!readNow) return;
    lastExpiryReadRef.current = Date.now();
    let stopped = false;
    let recheck: ReturnType<typeof setTimeout> | undefined;
    const candidates = trading.state.openOrders.filter((order) =>
      expiringIds.split(",").includes(`${order.market}:${order.orderId}`),
    );
    void (async () => {
      // What is cancelled is decided by the rollup's clock read now, never by
      // the estimate: a device clock that jumped since the offset was measured
      // must not end a live order.
      const fresh = await rollupNowMs();
      if (stopped) return;
      const expired = fresh === null ? [] : ordersPastExpiry(candidates, fresh);
      const confirmed = new Set(expired.map((order) => `${order.market}:${order.orderId}`));
      if (flagged.some((id) => !confirmed.has(id))) {
        recheck = setTimeout(() => setExpiryRecheck((count) => count + 1), EXPIRY_RECHECK_MS);
      }
      for (const order of expired) {
        const key = `${owner}:${order.market}:${order.orderId}`;
        if (autoCancelledRef.current.has(key)) continue;
        autoCancelledRef.current.add(key);
        await handleCancelOrder(order.market, order.orderId, EXPIRED_CANCEL_FAILURE_LEAD);
      }
    })();
    return () => {
      stopped = true;
      clearTimeout(recheck);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    owner,
    expiringIds,
    expiredOrderIds,
    tabGuard.elsewhere,
    rollupNowMs,
    expiryRecheck,
    expiryTick,
  ]);

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
    ? `${market.id} · ${env.networkLabel} · last data ${mark ? formatClockTime(new Date(mark.time)) : "unavailable"} · account ${ownerIdentity ? (trading.lastSyncedAtMs ? `synced at ${formatClockTime(new Date(trading.lastSyncedAtMs))}` : "not yet synced") : "no wallet"}`
    : env.networkLabel;

  const resetLayout = () => setLayoutResetSignal((signal) => signal + 1);
  const footer = !mainnet ? (
    statusBarText
  ) : isDesktop ? (
    <>
      <span className="truncate">Orders are private. The price updates about once a minute.</span>
      <span className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          className="rounded-tile text-faint hover:text-ink min-h-8 px-2 text-[12px] whitespace-nowrap transition-colors"
          onClick={resetLayout}
        >
          Reset layout
        </button>
        <PrivacyToolsToggle />
      </span>
    </>
  ) : null;

  const orderNotice = mainnet ? (
    <OrderNotice order={relevantSession?.descriptor ?? null} steps={railSteps} />
  ) : null;

  const orderEntry = market && (
    <OrderEntry
      key={market.id}
      onLimitLineChange={setLimitLine}
      market={market}
      mark={mark}
      now={now}
      hasWallet={!!ownerIdentity}
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
      openOrders={trading.state.openOrders}
      onCreateWallet={() => {
        if (!isMainnetBuild()) wallet.create();
      }}
      ownerAddress={owner}
      setup={
        isMainnetBuild() ? (
          <AccountSetup
            address={ownerIdentity?.address ?? null}
            funded={
              trading.accountLoaded ? Number(trading.state.collateral?.total ?? "0") > 0 : null
            }
            status={trading.accountStatus}
            needsInvite={trading.needsInvite}
            opening={trading.opening}
            outcome={trading.openOutcome}
            onOpen={(invite) => void trading.openAccount(invite)}
            onRecheck={trading.recheckAccount}
            keys={trading.orderKeys}
            now={now}
            ownerAuth={trading.ownerAuth}
            depositsOpen={FundsSection !== null}
          />
        ) : null
      }
      gate={
        tabGuard.elsewhere
          ? "otherTab"
          : trading.sessionStopped
            ? "signInStopped"
            : tradeGate(isMainnetBuild(), trading.accountStatus, trading.orderKeys)
      }
      makersListed={trading.makersListed.has(market.id)}
      limits={trading.marketLimits.get(market.id)}
      limitsState={trading.marketLimitsState}
      exposureUnreadable={trading.state.exposureUnreadable === true}
      tradingPause={tradingPause}
      onFund={() => trading.fund()}
      grantAlreadyUsed={trading.grantUsed}
      noFaucet={trading.noFaucet}
      quoteSymbol={quoteSymbol}
      placeOrder={trading.placeOrder}
      onOrderPlaced={handleOrderPlaced}
      onTransferToSpot={
        transferBetweenBalances
          ? async (toSpot, amount) => {
              if (tabGuard.elsewhere) {
                return { kind: "error", message: TRADING_IN_OTHER_TAB_NOTICE };
              }
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
      closingOnly={allData.marketsFromKept}
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
      cancelling={
        cancelling || (trackedOpenOrder !== null && cancellingIds.has(trackedOpenOrder.orderId))
      }
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
      expiryNow={expiryNow}
      ownFills={ownFillsForMarket}
      balances={balancesArray}
      collateral={trading.state.collateral ?? null}
      marketSettings={marketSettings}
      marksByMarket={data.marksByMarket}
      now={now}
      hasWallet={!!ownerIdentity}
      quoteSymbol={quoteSymbol}
      onTransfer={transferBetweenBalances}
      onClosePosition={requestClose}
      onReducePosition={requestReduce}
      limits={trading.marketLimits}
      exposureUnreadable={trading.state.exposureUnreadable === true}
      unseated={trading.state.unseated === true}
      onCancelOrder={trading.cancelOrder ? (m, id) => void handleCancelOrder(m, id) : null}
      cancellingOrderIds={
        cancelling ? new Set(trading.state.openOrders.map((order) => order.orderId)) : cancellingIds
      }
      transfers={
        FundsSection ? (
          <Suspense fallback={null}>
            <FundsSection
              identity={ownerIdentity}
              rollupReader={trading.rollupReader}
              confirmSeat={trading.confirmSeat}
              unseated={trading.state.unseated === true}
              withdrawByKey={trading.withdrawByKey}
              ownerAuthKnown={trading.ownerAuthKnown}
              accountOpen={trading.accountStatus === "open"}
              accountKnown={trading.accountStatus !== "unknown"}
              collateral={trading.state.collateral ?? null}
              onSettled={() => void trading.syncMarket(selectedMarketId)}
            />
          </Suspense>
        ) : (
          <TransferRecords owner={ownerIdentity?.address ?? null} engine={null} />
        )
      }
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
      takerFeeBps={trading.marketLimits.get(selectedMarketId)?.takerFeeBps}
      candles={candles}
      tape={tape}
      ownSequences={ownSequences}
      candlesLoading={candlesLoading}
      markStale={markStale}
      limitLine={limitLine}
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
      orderNotice={orderNotice}
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
      candles={candles}
      tape={tape}
      ownSequences={ownSequences}
      candlesLoading={candlesLoading}
      stats={data.stats}
      network={network}
      checkPrivacy={trading.checkPrivacy}
      markStale={markStale}
      limitLine={limitLine}
      clientDurationMs={clientDurationMs}
      mainnet={mainnet}
      toolsOn={toolsOn}
      orderNotice={orderNotice}
    />
  );

  return (
    <TerminalShell
      connectionState={data.connectionState}
      wallet={wallet}
      footer={footer}
      onResetLayout={isDesktop && !mainnet ? resetLayout : undefined}
      notices={
        <TerminalNotices
          owner={ownerIdentity?.address ?? null}
          pricesUnreachable={allData.marketsUnreachable}
          usingKeptSettings={allData.marketsFromKept}
          tradingElsewhere={tabGuard.elsewhere}
          onUseThisTab={tabGuard.takeOver}
          sessionStopped={trading.sessionStopped}
          onSignInAgain={() => void trading.signInAgain()}
        />
      }
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
