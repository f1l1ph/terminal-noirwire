"use client";

import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import {
  formatDecimal,
  formatMoney,
  formatPercent,
  formatRelativeAge,
  UNAVAILABLE,
} from "@/lib/format";
import { ageMs, isStale, STALE_MARK_MS } from "@/lib/market-data/selectors";
import { priceDecimalsOf, sizeDecimalsOf } from "@/lib/market-data/precision";
import type { MarketInfo } from "@/lib/market-data/types";
import { fromFixedPoint, toFixedPoint } from "@/lib/trading/decimal";
import { displayOrderCost, estimateOrderCost } from "@/lib/trading/risk";
import { maxOrderSize, orderFunds } from "@/lib/trading/sizing";
import type { PlacedOrderOutcome } from "@/lib/trading/useTrading";
import type { UnknownHold } from "@/lib/rollup/accountMemory";
import { OrderOutcomeUnknownError } from "@/lib/trading/unknownOutcome";
import { describeFieldError, markMovedMaterially, validateOrder } from "@/lib/trading/validation";
import { needsSpotTransfer } from "@/lib/trading/spotTransfer";
import { availableLabel, isAvailableUnknown } from "@/lib/trading/balanceDisplay";
import type {
  Balance,
  FundOutcome,
  NewOrderInput,
  Position,
  Side,
  SpotAssets,
} from "@/lib/trading/types";
import type { OrderDescriptor } from "@/components/WitnessRail";
import { OrderSummary } from "@/components/OrderSummary";
import { TransferControl, type TransferFn } from "@/components/TransferControl";
import {
  btnDanger,
  btnGhost,
  btnPrimary,
  btnSafe,
  input,
  rangeBrand,
} from "@/components/ui/styles";

const PERCENT_SHORTCUTS = [25, 50, 75, 100];
const GOOD_FOR_OPTIONS = [
  { value: "untilCancelled", label: "Until cancelled" },
  { value: "1m", label: "1 minute" },
  { value: "1h", label: "1 hour" },
] as const;

/**
 * A dock row's "Close" (reduce-only, full size, submits through the usual
 * confirmation) or "Reduce" (prefills only) request. `requestId` always
 * changes so a second click with identical values still re-triggers the
 * effect below.
 */
export interface PrefillRequest {
  market: string;
  side: Side;
  size: string;
  reduceOnly: boolean;
  submit: boolean;
  requestId: number;
}

/** Exactly what the confirm dialog showed and what will be signed, fixed when the dialog opened. */
interface FrozenOrder {
  draft: NewOrderInput;
  descriptor: OrderDescriptor;
  markPrice: string;
  worstCost: string;
  leverage: number;
  /** The price field held a typed price, not the default that follows the mark. */
  priceTyped: boolean;
  /** The figures the dialog's summary shows, fixed with the order so they cannot drift from the reviewed cost. */
  estimateDisplay: ComponentProps<typeof OrderSummary>["display"];
  remainingAvailable: string | null;
}

export function OrderEntry({
  market,
  mark,
  now,
  hasWallet,
  walletReady,
  walletLocked,
  balances,
  collateral,
  accountError,
  accountLoaded,
  onOrderUnknown,
  unknownHold,
  onClearUnknownHold,
  position,
  onCreateWallet,
  onFund,
  grantAlreadyUsed,
  noFaucet,
  quoteSymbol,
  placeOrder,
  onOrderPlaced,
  onTransferToSpot,
  supportsGoodFor,
  placeOrderPending,
  prefillRequest,
  spotAssets,
  compact,
}: {
  market: MarketInfo | undefined;
  mark: { price: string; time: number } | null;
  now: number;
  hasWallet: boolean;
  walletReady: boolean;
  /** An encrypted wallet is kept on this device but not unlocked: never offer to create another over it. */
  walletLocked: boolean;
  balances: Record<string, Balance>;
  /** The separate perpetuals collateral account. `undefined` in dev mode. */
  collateral?: Balance;
  /** The account could not be read: balances are unknown, not zero. Trading and funding are off until it can. */
  accountError: string | null;
  /** The account has been read successfully at least once: until then its balances are unknown, not zero. */
  accountLoaded: boolean;
  /** An order may have reached the venue with no way to learn its result: the draft and secret are held here by the parent. */
  onOrderUnknown: (descriptor: OrderDescriptor, hold: UnknownHold) => void;
  /** Such an order is still unresolved for this market: no other order is accepted until it is proven or cleared. */
  unknownHold: { clearableAtMs: number } | null;
  onClearUnknownHold: () => void;
  position: Position | null;
  onCreateWallet: () => void;
  onFund: () => Promise<FundOutcome>;
  /**
   * This wallet has already asked for its one-time grant, on this browser
   * or (learned from an `alreadyFunded` answer) elsewhere. Never offer the
   * grant action or an "already received" notice again once this is true
   * (third design review, must-fix 2); show "Grant used" in the account
   * details instead, whatever the current balance is.
   */
  grantAlreadyUsed: boolean;
  /** The service said this deployment hands out no test funds: the grant action is never offered again on this page. */
  noFaucet: boolean;
  /** The quote token's name as the venue gives it (nUSD, USDC); empty while not yet known. */
  quoteSymbol: string;
  placeOrder: (input: NewOrderInput) => Promise<PlacedOrderOutcome>;
  onOrderPlaced: (outcome: PlacedOrderOutcome, descriptor: OrderDescriptor) => void;
  /** Present only in rollup mode, where collateral and spot are separate balances. */
  onTransferToSpot: TransferFn | null;
  /** Rollup limit orders can carry their own expiry (RULES.md section 4); dev-mode orders cannot. */
  supportsGoodFor: boolean;
  /**
   * An order in this market is still being checked with the venue (rollup
   * mode, 0.3.1): blocks resubmitting the same intent (this button) until
   * it clears, without blocking cancel or transfer - those lend a different
   * order-key slot.
   */
  placeOrderPending: boolean;
  /** A dock row's Close/Reduce request for this market; applied once per `requestId`, ignored for any other market (switching markets remounts this component via its own `key`, so a stale request for a market just left behind can never apply here). */
  prefillRequest?: PrefillRequest | null;
  /** The balance names of this spot market's two tokens, as the venue's own deployment description gives them. Absent for a perp and in dev mode, where the market's own base and quote names are the balance names. */
  spotAssets?: SpotAssets;
  /**
   * Phone only: leverage and the full cost breakdown collapse behind a
   * disclosure, off by default, so the primary action lands in the first
   * viewport alongside side, quantity and available balance (second design
   * review, item 10) - nothing is removed, it is one tap away.
   */
  compact?: boolean;
}) {
  const isPerp = market?.kind === "perp";
  const [side, setSide] = useState<Side>("buy");
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [quantityText, setQuantityText] = useState("");
  const [priceOverride, setPriceOverride] = useState<string | null>(null);
  const [quantityTouched, setQuantityTouched] = useState(false);
  const [priceTouched, setPriceTouched] = useState(false);
  const [leverage, setLeverage] = useState(1);
  const [reduceOnly, setReduceOnly] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [funding, setFunding] = useState(false);
  const [fundMessage, setFundMessage] = useState<string | null>(null);
  // On a real network, a brand-new account's first read can lag several
  // seconds behind its own grant transaction landing (the account has to
  // actually propagate before a read sees it) - set the moment a grant is
  // confirmed, cleared once a real balance shows up or after a bounded
  // wait, so "0.00 nUSD" is never shown for an account that is in fact
  // funded and simply not visible yet.
  const [confirmingFund, setConfirmingFund] = useState(false);
  const confirmingFundTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [showDetails, setShowDetails] = useState(!compact);
  const [frozen, setFrozen] = useState<FrozenOrder | null>(null);
  const [openAfterPrefill, setOpenAfterPrefill] = useState(false);
  const submittingRef = useRef(false);
  const quantityInputRef = useRef<HTMLInputElement>(null);
  const priceInputRef = useRef<HTMLInputElement>(null);
  const appliedPrefillIdRef = useRef<number | null>(null);

  // Applies a dock row's Close/Reduce request once per `requestId`. Scoped
  // to this exact market: a market switch remounts this component (its
  // `key` is the market id), so a request meant for the market just left
  // can never leak into the freshly-mounted form for the new one.
  // Syncing this form's state to an external request (a dock row's
  // Close/Reduce click) is exactly the documented case for an effect, not
  // a derived-state anti-pattern; it cannot be done during render since it
  // reacts to a prop set by a sibling component's own event handler.
  useEffect(() => {
    if (!prefillRequest || !market || prefillRequest.market !== market.id) return;
    if (appliedPrefillIdRef.current === prefillRequest.requestId) return;
    appliedPrefillIdRef.current = prefillRequest.requestId;
    setOrderType("market");
    setSide(prefillRequest.side);
    setQuantityText(prefillRequest.size);
    setQuantityTouched(true);
    setPriceOverride(null);
    setPriceTouched(false);
    setReduceOnly(prefillRequest.reduceOnly);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (prefillRequest.submit) setOpenAfterPrefill(true);
  }, [prefillRequest, market]);

  const priceDecimals = market ? priceDecimalsOf(market) : 2;
  const sizeDecimals = market ? sizeDecimalsOf(market) : 4;

  const defaultBoundPrice = useMemo(() => {
    if (!mark || !market) return "";
    const base = Number(mark.price);
    if (!Number.isFinite(base)) return "";
    if (orderType === "market") {
      const slippage = side === "buy" ? 1.01 : 0.99;
      return (base * slippage).toFixed(priceDecimals);
    }
    // Limit: default to a plausible resting price on the passive side of
    // the mark (a buy below it, a sell above it), tick-aligned, so the
    // field never opens on an off-tick test fixture or a price that would
    // simply cross the spread and fill at once (third design review,
    // must-fix 6).
    const passive = side === "buy" ? base * 0.995 : base * 1.005;
    const tick = Number(market.tickSize);
    const aligned = tick > 0 ? Math.round(passive / tick) * tick : passive;
    return aligned.toFixed(priceDecimals);
  }, [orderType, mark, side, market, priceDecimals]);
  const priceText = priceOverride ?? defaultBoundPrice;

  const baseUnit = spotAssets?.base ?? market?.base ?? "";
  const quoteUnit = spotAssets?.quote ?? quoteSymbol;
  const money = (value: string) => formatMoney(value, quoteUnit);
  const quoteBalance = balances[quoteUnit];
  const availableBase = balances[baseUnit]?.available ?? "0";
  // A perp order draws on the separate collateral account (RULES.md section
  // 6), not the spot quote balance; dev mode has no such split, so there
  // `collateral` is undefined and the spot balance is the only figure.
  // The collateral's available figure was priced from the marks of every
  // market with exposure; once any of them goes stale it is unknown, whatever
  // market is selected here.
  const availableUnknown = isPerp && isAvailableUnknown(collateral, now);
  const availableQuote =
    isPerp && collateral
      ? availableUnknown
        ? "0"
        : collateral.available
      : (quoteBalance?.available ?? "0");

  useEffect(() => {
    if (confirmingFund && Number(availableQuote) > 0) {
      // Syncing to an external signal (the venue's own balance finally
      // showing up) is the documented case for an effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConfirmingFund(false);
      if (confirmingFundTimeoutRef.current) clearTimeout(confirmingFundTimeoutRef.current);
    }
  }, [confirmingFund, availableQuote]);

  const markStale = isStale(mark?.time, now, STALE_MARK_MS);
  const markAge = ageMs(mark?.time, now);
  const [goodFor, setGoodFor] = useState<NewOrderInput["goodFor"]>("untilCancelled");
  const [showTransfer, setShowTransfer] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const reduceOnlyMax = useMemo(() => {
    if (!isPerp || !reduceOnly || !position) return undefined;
    const size = Number(position.size);
    const sameSign = (side === "buy" && size < 0) || (side === "sell" && size > 0);
    return sameSign ? String(Math.abs(size)) : "0";
  }, [isPerp, reduceOnly, position, side]);

  const maxQuantity = useMemo(() => {
    if (!market) return "0";
    return maxOrderSize({
      mode: market.kind,
      side,
      price: priceText || mark?.price || "0",
      lotSize: market.lotSize,
      // The venue's margin requirement is always the market's fixed ratio
      // (maxLeverage), never the leverage slider's value; see `orderFunds`.
      leverage: market.maxLeverage,
      availableQuote,
      availableBase,
      reduceOnlyMax,
    });
  }, [market, side, priceText, mark, availableQuote, availableBase, reduceOnlyMax]);

  const draft: NewOrderInput | null = market
    ? {
        market: market.id,
        side,
        type: orderType,
        price: priceText,
        size: quantityText,
        reduceOnly: isPerp && reduceOnly ? true : undefined,
        goodFor: supportsGoodFor && orderType === "limit" ? goodFor : undefined,
      }
    : null;

  const validation = market && draft ? validateOrder(draft, market, mark, now) : null;
  const quantityError =
    quantityTouched && validation?.errors.quantity
      ? describeFieldError(validation.errors.quantity, { ...market!, base: baseUnit })
      : null;
  const priceError =
    priceTouched && validation?.errors.price
      ? describeFieldError(validation.errors.price, market!)
      : null;

  const estimate = useMemo(() => {
    if (!market || !priceText || !quantityText.trim()) return null;
    try {
      return estimateOrderCost({
        side,
        quantity: quantityText,
        price: priceText,
        leverage: isPerp ? leverage : 1,
        maxLeverage: market.maxLeverage,
      });
    } catch {
      return null;
    }
  }, [market, priceText, quantityText, side, leverage, isPerp]);

  const estimateDisplay = market && estimate ? displayOrderCost(estimate, priceDecimals) : null;

  const funds = useMemo(() => {
    if (!market || !priceText || !quantityText.trim()) return null;
    try {
      return orderFunds({
        mode: market.kind,
        side,
        quantity: quantityText,
        price: priceText,
        maxLeverage: market.maxLeverage,
        availableQuote,
        availableBase,
      });
    } catch {
      return null;
    }
  }, [market, priceText, quantityText, side, availableQuote, availableBase]);

  const remainingAvailable = funds
    ? fromFixedPoint(toFixedPoint(availableQuote) - funds.requiredQuote, 6)
    : availableQuote;
  const shortfall = funds?.shortfall ?? null;
  const unaffordable = shortfall !== null;
  const staleBlock = markStale;

  const isSpotSell = !isPerp && side === "sell";
  const accountUnknown = hasWallet && (!!accountError || !accountLoaded);
  const noFunds =
    hasWallet &&
    !accountUnknown &&
    !availableUnknown &&
    Number(availableQuote) <= 0 &&
    !(isSpotSell && Number(availableBase) > 0);

  // Spot buy, this browser's spot quote balance is empty, but there is
  // collateral to move: the primary action becomes "Move funds to spot"
  // rather than a pointless test-funds grant (one grant only, already
  // spent) or a submit that would just fail for insufficient balance. See
  // `needsSpotTransfer` in trading/spotTransfer.ts for the decision itself.
  const needsTransfer = needsSpotTransfer({
    isPerp,
    side,
    hasWallet,
    canTransfer: !!onTransferToSpot,
    spotAvailable: Number(quoteBalance?.available ?? "0"),
    collateralAvailable:
      collateral && !isAvailableUnknown(collateral, now) ? Number(collateral.available) : null,
  });
  const suggestedTransferAmount = funds ? fromFixedPoint(funds.requiredQuote, 6) : undefined;

  const canSubmit =
    hasWallet &&
    !accountUnknown &&
    !availableUnknown &&
    !noFunds &&
    !!market &&
    !!validation?.valid &&
    !unaffordable &&
    !staleBlock &&
    !submitting &&
    !placeOrderPending &&
    !unknownHold;

  const confirmBlocker = (() => {
    if (!market) return null;
    if (unknownHold) return "An earlier order may have reached the venue. Check it first.";
    if (accountUnknown) return "Your account could not be read, so this order cannot be placed.";
    if (availableUnknown) return "Available collateral is unavailable until the price updates.";
    if (validation?.errors.quantity) {
      return describeFieldError(validation.errors.quantity, { ...market, base: baseUnit });
    }
    if (validation?.errors.price) return describeFieldError(validation.errors.price, market);
    if (staleBlock) return "Market data is too old. Wait for a fresh mark.";
    if (unaffordable) return "Your available balance no longer covers this order.";
    if (placeOrderPending) return "An order is still being checked with the venue.";
    return canSubmit ? null : "This order cannot be placed right now.";
  })();

  /** What the dialog will freeze: the exact signed fields and the worst case the order can cost. */
  function freezeOrder(): FrozenOrder | null {
    if (!draft || !market || !mark) return null;
    const worstCost = isSpotSell
      ? `${formatDecimal(quantityText, sizeDecimals)} ${baseUnit} sold`
      : funds
        ? `${money(fromFixedPoint(funds.requiredQuote, 6))} including fee${isPerp ? " and margin" : ""}`
        : UNAVAILABLE;
    return {
      draft: { ...draft },
      descriptor: {
        market: market.id,
        side,
        type: orderType,
        price: priceText,
        size: quantityText,
        kind: market.kind,
        baseUnit,
        quoteUnit,
        priceDecimals,
        sizeDecimals,
      },
      markPrice: mark.price,
      worstCost,
      leverage,
      priceTyped: priceOverride !== null,
      estimateDisplay,
      remainingAvailable,
    };
  }

  /** The one entry to the confirmation, from a click and from a dock Close: nothing opens unless the order can be placed right now. */
  function openConfirm() {
    if (!canSubmit) {
      setSubmitError(confirmBlocker);
      return;
    }
    const order = freezeOrder();
    if (!order) return;
    // The price stops following the mark while it is under review.
    setPriceOverride(order.draft.price);
    setFrozen(order);
    setSubmitError(null);
    setShowConfirm(true);
  }

  // Opens the confirmation for a dock Close only once the prefilled values
  // are in the render, through the same checks as a click on the primary
  // button.
  useEffect(() => {
    if (!openAfterPrefill) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpenAfterPrefill(false);
    openConfirm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openAfterPrefill]);

  // The review stands only while the order is what was shown and the mark is
  // where it was; otherwise it must be reopened.
  const reviewInvalid = (() => {
    if (!showConfirm || !frozen || !draft) return null;
    const changed =
      draft.market !== frozen.draft.market ||
      draft.side !== frozen.draft.side ||
      draft.type !== frozen.draft.type ||
      draft.price !== frozen.draft.price ||
      draft.size !== frozen.draft.size ||
      draft.reduceOnly !== frozen.draft.reduceOnly ||
      draft.goodFor !== frozen.draft.goodFor;
    if (changed) return "The order was changed after you opened this review.";
    if (markMovedMaterially(frozen.markPrice, mark?.price)) {
      return "The market price moved after you opened this review.";
    }
    return null;
  })();

  async function runSubmit(order: FrozenOrder) {
    if (!market || submittingRef.current) return;
    // The full check again, on the frozen order and the mark as it is now.
    const recheck = validateOrder(order.draft, market, mark, now);
    const marginExpired = isPerp && isAvailableUnknown(collateral, Math.max(now, Date.now()));
    if (
      !canSubmit ||
      marginExpired ||
      !recheck.valid ||
      markMovedMaterially(order.markPrice, mark?.price)
    ) {
      setSubmitError(confirmBlocker ?? "The order can no longer be placed as reviewed.");
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    const { draft: submitted, descriptor } = order;
    try {
      const outcome = await placeOrder(submitted);
      onOrderPlaced(outcome, descriptor);
      if (outcome.result.status !== "rejected") {
        setQuantityText("");
        setQuantityTouched(false);
        setPriceOverride(null);
        setPriceTouched(false);
      }
      // The panel must always start at its top (the side/type buttons were
      // found scrolled out of view after a fill in the second-pass review):
      // a fill grows the summary above the button, which can leave the
      // scroll position mid-panel on the next render.
      containerRef.current?.scrollTo({ top: 0 });
    } catch (error) {
      if (error instanceof OrderOutcomeUnknownError) {
        onOrderUnknown(descriptor, error.hold);
      } else {
        setSubmitError(error instanceof Error ? error.message : "Could not reach the venue");
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function focusFirstInvalid() {
    if (validation?.errors.quantity) quantityInputRef.current?.focus();
    else if (validation?.errors.price) priceInputRef.current?.focus();
  }

  function handlePrimaryClick() {
    if (!walletReady || accountUnknown) return;
    if (!hasWallet) {
      if (!walletLocked) onCreateWallet();
      return;
    }
    if (needsTransfer) {
      setShowTransfer(true);
      return;
    }
    if (noFunds && !grantAlreadyUsed && !noFaucet) {
      setFunding(true);
      setFundMessage(null);
      onFund()
        .then((outcome) => {
          if (outcome.kind === "alreadyFunded" || outcome.kind === "noFaucet") {
            // Learned only now that this wallet was granted elsewhere, or
            // that this deployment grants nothing: `grantAlreadyUsed` or
            // `noFaucet` flips on the next render and says so in place of
            // the grant action - no separate notice here.
            setFundMessage(null);
          } else if (outcome.kind === "rateLimited") {
            setFundMessage(
              outcome.message ??
                "Too many funding requests from this network right now. Try again shortly.",
            );
          } else if (outcome.kind === "error") {
            setFundMessage(outcome.message);
          } else {
            setFundMessage(null);
            setConfirmingFund(true);
            if (confirmingFundTimeoutRef.current) clearTimeout(confirmingFundTimeoutRef.current);
            confirmingFundTimeoutRef.current = setTimeout(() => setConfirmingFund(false), 15_000);
          }
        })
        .catch((error: unknown) =>
          setFundMessage(error instanceof Error ? error.message : "Could not reach the venue."),
        )
        .finally(() => setFunding(false));
      return;
    }
    setQuantityTouched(true);
    setPriceTouched(true);
    if (!canSubmit) {
      focusFirstInvalid();
      return;
    }
    openConfirm();
  }

  function closeReview() {
    setShowConfirm(false);
    if (frozen && !frozen.priceTyped) setPriceOverride(null);
  }

  function handleConfirm() {
    if (!frozen || reviewInvalid || !canSubmit) return;
    closeReview();
    void runSubmit(frozen);
  }

  if (!market) {
    return (
      <div
        className={`text-faint p-4 text-[13px] ${compact ? "bg-surface border-line-subtle rounded-panel border" : ""}`}
      >
        Loading market settings.
      </div>
    );
  }

  const actionWord = isPerp ? (side === "buy" ? "long" : "short") : side === "buy" ? "buy" : "sell";
  const submitLabel = `Place test ${actionWord}`;

  let primaryLabel = submitLabel;
  let primaryClass = side === "buy" ? btnSafe : btnDanger;
  let primaryDisabled = !canSubmit;
  if (!walletReady) {
    primaryLabel = "Loading wallet…";
    primaryClass = btnPrimary;
    primaryDisabled = true;
  } else if (!hasWallet && walletLocked) {
    primaryLabel = "Unlock your wallet to trade";
    primaryClass = btnGhost;
    primaryDisabled = true;
  } else if (!hasWallet) {
    primaryLabel = "Create test wallet";
    primaryClass = btnPrimary;
    primaryDisabled = false;
  } else if (accountUnknown) {
    primaryLabel = accountError ? "Account unavailable" : "Loading account…";
    primaryClass = btnGhost;
    primaryDisabled = true;
  } else if (availableUnknown) {
    primaryLabel = "Waiting for price";
    primaryClass = btnGhost;
    primaryDisabled = true;
  } else if (unknownHold) {
    primaryLabel = "Order outcome unknown";
    primaryClass = btnGhost;
    primaryDisabled = true;
  } else if (placeOrderPending) {
    primaryLabel = "Checking with the venue…";
    primaryClass = btnGhost;
    primaryDisabled = true;
  } else if (needsTransfer) {
    primaryLabel = "Move funds to spot";
    primaryClass = btnPrimary;
    primaryDisabled = false;
  } else if (noFunds && confirmingFund && collateral !== undefined) {
    primaryLabel = "Confirming on chain…";
    primaryClass = btnGhost;
    primaryDisabled = true;
  } else if (noFunds && grantAlreadyUsed) {
    // The grant is spent and there is nowhere left to ask for more: the
    // account-details line below says "Grant used", and the primary action
    // is the ordinary empty-form state, never a repeat grant offer.
    primaryLabel = "Enter quantity";
    primaryClass = btnGhost;
    primaryDisabled = true;
  } else if (noFunds && noFaucet) {
    primaryLabel = "No test funds on this deployment";
    primaryClass = btnGhost;
    primaryDisabled = true;
  } else if (noFunds) {
    // The size of a grant, and whether one exists at all, is the service's
    // to say: it is only known once asked, so the offer names no amount.
    primaryLabel = "Get test funds";
    primaryClass = btnPrimary;
    primaryDisabled = funding;
  } else if (!quantityText.trim()) {
    primaryLabel = "Enter quantity";
    primaryClass = btnGhost;
    primaryDisabled = true;
  }

  const percentOf = (pct: number) => {
    const max = Number(maxQuantity);
    if (!Number.isFinite(max) || max <= 0) return "0";
    const lot = Number(market.lotSize);
    const raw = (max * pct) / 100;
    const steps = Math.floor(raw / lot);
    return (steps * lot).toFixed(sizeDecimals);
  };

  return (
    <div
      ref={containerRef}
      className={`flex flex-col gap-0.5 p-1.5 ${
        compact
          ? "bg-surface border-line-subtle rounded-panel border"
          : "min-h-0 flex-1 overflow-y-auto"
      }`}
    >
      <p className="text-ink-strong text-[13px] font-medium">
        Trade {market.id} · {market.kind === "perp" ? "Perpetual, cross margin" : "Spot"}
      </p>

      <div className="flex gap-2" role="group" aria-label="Side">
        <button
          type="button"
          aria-pressed={side === "buy"}
          onClick={() => setSide("buy")}
          className={`${side === "buy" ? btnSafe : btnGhost} h-10 flex-1 text-[13px]`}
        >
          {isPerp ? "Long" : "Buy"}
        </button>
        <button
          type="button"
          aria-pressed={side === "sell"}
          onClick={() => setSide("sell")}
          className={`${side === "sell" ? btnDanger : btnGhost} h-10 flex-1 text-[13px]`}
        >
          {isPerp ? "Short" : "Sell"}
        </button>
      </div>

      <div className="flex gap-2" role="group" aria-label="Order type">
        {(["market", "limit"] as const).map((type) => (
          <button
            key={type}
            type="button"
            aria-pressed={orderType === type}
            onClick={() => setOrderType(type)}
            className={`rounded-tile min-h-9 flex-1 border px-3 text-[12px] capitalize ${
              orderType === type
                ? "border-line-strong bg-elevated text-ink"
                : "border-line text-dim"
            }`}
          >
            {type}
          </button>
        ))}
      </div>

      <div>
        <div className="flex items-baseline justify-between">
          <label className="text-faint text-[12px]" htmlFor="order-quantity">
            Quantity ({baseUnit})
          </label>
          <span className="text-faint text-[11px]">
            {/* "Confirming on chain" only makes sense where funding lands - the separate perpetuals collateral account, rollup mode only (`collateral` is undefined in dev mode, which has no chain to confirm against). */}
            {isSpotSell
              ? `Available: ${formatDecimal(availableBase, sizeDecimals)} ${baseUnit}`
              : availableUnknown && collateral
                ? availableLabel(collateral, money, now)
                : confirmingFund && collateral !== undefined && Number(availableQuote) <= 0
                  ? "Confirming on chain…"
                  : grantAlreadyUsed
                    ? `Grant used · ${money(availableQuote)} available`
                    : `Available: ${money(availableQuote)}`}
          </span>
        </div>
        <input
          ref={quantityInputRef}
          id="order-quantity"
          className={`${input} mt-1`}
          inputMode="decimal"
          placeholder="0.00"
          value={quantityText}
          aria-describedby={quantityError ? "order-quantity-error" : "order-quantity-hint"}
          onBlur={() => setQuantityTouched(true)}
          onChange={(event) => {
            setQuantityText(event.target.value);
            setQuantityTouched(true);
          }}
        />
        {quantityError ? (
          <p id="order-quantity-error" role="alert" className="text-danger mt-0.5 text-[12px]">
            {quantityError}
          </p>
        ) : (
          <p id="order-quantity-hint" className="text-faint mt-0.5 text-[11px]">
            Min {market.lotSize} {baseUnit} · step {market.lotSize}
          </p>
        )}
        <div className="mt-0.5 flex gap-1" role="group" aria-label="Quantity shortcuts">
          {PERCENT_SHORTCUTS.map((pct) => (
            <button
              key={pct}
              type="button"
              className={`${btnGhost} h-7 flex-1 text-[11px]`}
              onClick={() => {
                setQuantityText(percentOf(pct));
                setQuantityTouched(true);
              }}
            >
              {pct === 100 ? "Max" : `${pct}%`}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="text-faint text-[12px]" htmlFor="order-price">
          {orderType === "market"
            ? side === "buy"
              ? "Max buy price"
              : "Min sell price"
            : "Limit price"}
          {quoteUnit && ` (${quoteUnit})`}
        </label>
        <input
          ref={priceInputRef}
          id="order-price"
          className={`${input} mt-1`}
          inputMode="decimal"
          placeholder={orderType === "limit" ? "" : undefined}
          value={priceText}
          aria-describedby={priceError ? "order-price-error" : "order-price-hint"}
          onBlur={() => setPriceTouched(true)}
          onChange={(event) => {
            setPriceOverride(event.target.value);
            setPriceTouched(true);
          }}
        />
        {priceError ? (
          <p id="order-price-error" role="alert" className="text-danger mt-0.5 text-[12px]">
            {priceError}
          </p>
        ) : orderType === "market" && mark && !markStale ? (
          <p id="order-price-hint" className="text-faint mt-0.5 text-[11px]">
            {formatPercent(((Number(priceText) - Number(mark.price)) / Number(mark.price)) * 100)}{" "}
            from mark · mark age {markAge !== null ? formatRelativeAge(markAge) : UNAVAILABLE}
          </p>
        ) : (
          <p id="order-price-hint" className="text-faint mt-0.5 text-[11px]">
            Filled only at this price or better.
          </p>
        )}
      </div>

      {supportsGoodFor && orderType === "limit" && (
        <div>
          <label className="text-faint text-[12px]" htmlFor="order-good-for">
            Good for
          </label>
          <select
            id="order-good-for"
            className={`${input} mt-1`}
            value={goodFor}
            onChange={(event) => setGoodFor(event.target.value as NewOrderInput["goodFor"])}
          >
            {GOOD_FOR_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {compact && (
        <button
          type="button"
          className="text-faint self-start text-[11px] underline"
          onClick={() => setShowDetails((value) => !value)}
          aria-expanded={showDetails}
        >
          {showDetails ? "Hide" : "Show"} leverage &amp; order details
        </button>
      )}

      {/* Reduce only stays visible even collapsed: it changes what the
          order DOES, not just a cost estimate, so it is not "secondary
          evidence" in the sense the phone layout collapses. */}
      {isPerp && position && Number(position.size) !== 0 && (
        <label className="text-dim flex items-center gap-2 text-[12px]">
          <input
            type="checkbox"
            checked={reduceOnly}
            onChange={(event) => setReduceOnly(event.target.checked)}
          />
          Reduce only
        </label>
      )}

      {isPerp && showDetails && (
        <div>
          <label
            className="text-faint flex justify-between text-[12px]"
            htmlFor="order-leverage"
            title="Display only: the venue sets margin by its own fixed ratio, not this slider."
          >
            <span>Leverage</span>
            <span className="tnum text-ink">
              {leverage}x (1-{market.maxLeverage}x)
            </span>
          </label>
          <input
            id="order-leverage"
            type="range"
            min={1}
            max={market.maxLeverage}
            step={1}
            value={leverage}
            onChange={(event) => setLeverage(Number(event.target.value))}
            className={`${rangeBrand} mt-1`}
          />
        </div>
      )}

      {accountUnknown && accountError && (
        <p role="alert" className="text-danger text-[12px]">
          Could not read your account, so your balance is unknown (not zero). Trading and test funds
          are off until it loads. Reload the page to try again.
        </p>
      )}
      {unknownHold && (
        <div role="alert" className="text-danger text-[12px]">
          <p>
            An order may have reached the venue and its result is unknown. Check Open orders and
            Positions before placing another. The form stays locked until one of its fills shows up
            or you clear this, which is possible only{" "}
            {now >= unknownHold.clearableAtMs
              ? "now."
              : `in about ${Math.ceil((unknownHold.clearableAtMs - now) / 1000)}s.`}
          </p>
          <button
            type="button"
            className={`${btnGhost} mt-1 h-8 px-3 text-[12px]`}
            disabled={now < unknownHold.clearableAtMs}
            onClick={() => {
              if (
                window.confirm(
                  "The order may still be live and may still fill. Clear the lock only if you checked Open orders and Positions and accept that risk. Clear the lock?",
                )
              ) {
                onClearUnknownHold();
              }
            }}
          >
            I checked, clear the lock
          </button>
        </div>
      )}
      {staleBlock && (
        <p role="alert" className="text-warning text-[12px]">
          Market data is {markAge !== null ? formatRelativeAge(markAge) : "too"} old. Wait for a
          fresh mark.
        </p>
      )}
      {shortfall && !staleBlock && (
        <p role="alert" className="text-danger text-[12px]">
          {shortfall.asset === "base"
            ? `Available ${formatDecimal(shortfall.available, sizeDecimals)} ${baseUnit}; this order sells ${formatDecimal(shortfall.needed, sizeDecimals)} ${baseUnit}.`
            : `Available ${money(shortfall.available)}; this order needs about ${money(shortfall.needed)} including fee.`}{" "}
          Reduce quantity.
        </p>
      )}

      {showDetails && (
        <OrderSummary
          side={side}
          isPerp={isPerp}
          display={estimateDisplay}
          priceDecimals={priceDecimals}
          remainingAvailable={remainingAvailable}
          quoteSymbol={quoteUnit}
        />
      )}

      <button
        type="button"
        className={`${primaryClass} h-11 w-full`}
        disabled={primaryDisabled}
        onClick={handlePrimaryClick}
      >
        {funding ? "Requesting…" : submitting ? "Submitting…" : primaryLabel}
      </button>

      {/* Only a genuine problem (rate limit, error) ever shows here now, and
          only while it is still true: `noFunds` turning false (funds
          landed) retires it instead of leaving it under the button
          alongside a working order form (third design review, must-fix 2). */}
      {fundMessage && noFunds && <p className="text-warning text-[12px]">{fundMessage}</p>}
      {noFaucet && noFunds && (
        <p className="text-dim text-[12px]">
          This deployment has no faucet, so it hands out no test funds. You can still follow the
          market, its chart and its public fills here.
        </p>
      )}

      {showTransfer && onTransferToSpot && collateral && (
        <TransferControl
          onTransfer={onTransferToSpot}
          collateral={collateral}
          spot={quoteBalance ?? null}
          quoteSymbol={quoteUnit}
          prefillAmount={suggestedTransferAmount}
          initiallyOpen
          onDone={() => setShowTransfer(false)}
        />
      )}

      {submitError && (
        <p role="alert" className="text-danger text-[13px]">
          {submitError}
        </p>
      )}

      {showConfirm &&
        frozen &&
        // A portal to `document.body`, not an in-place `fixed inset-0`: nested
        // inside a dockview panel, this div's ancestor chain includes an
        // element with its own CSS transform (dockview's overlay renderer),
        // which makes ANY descendant's `position: fixed` relative to that
        // transformed box instead of the viewport - exactly the CSS
        // containing-block rule that would otherwise strand this dialog
        // over the Order ticket's own small panel rather than the screen.
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Confirm order"
            className="bg-base/80 fixed inset-0 z-20 flex items-center justify-center p-4"
          >
            <div className="bg-surface border-line-strong rounded-panel w-full max-w-sm border p-5">
              <p className="text-ink-strong text-[14px] font-medium">
                {frozen.draft.market} · {frozen.draft.type === "market" ? "Market" : "Limit"} ·{" "}
                {isPerp
                  ? frozen.draft.side === "buy"
                    ? "Long"
                    : "Short"
                  : frozen.draft.side === "buy"
                    ? "Buy"
                    : "Sell"}{" "}
                {formatDecimal(frozen.draft.size, sizeDecimals)} {baseUnit}
                {isPerp ? ` · ${frozen.leverage}x cross` : ""}
              </p>
              <p className="text-faint mt-1 text-[12px]">
                {frozen.draft.type === "market"
                  ? frozen.draft.side === "buy"
                    ? "Max buy price "
                    : "Min sell price "
                  : "Limit price "}
                {formatDecimal(frozen.draft.price, priceDecimals)} {quoteUnit}
              </p>
              <p className="text-faint mt-1 text-[12px]">Worst case: {frozen.worstCost}</p>
              <OrderSummary
                side={frozen.draft.side}
                isPerp={isPerp}
                display={frozen.estimateDisplay}
                priceDecimals={priceDecimals}
                remainingAvailable={frozen.remainingAvailable}
                quoteSymbol={quoteUnit}
              />
              {(reviewInvalid ?? confirmBlocker) && (
                <p role="alert" className="text-danger mt-3 text-[12px]">
                  {reviewInvalid ?? confirmBlocker}
                </p>
              )}
              <div className="mt-4 flex gap-3">
                <button type="button" className={`${btnGhost} h-11 flex-1`} onClick={closeReview}>
                  Back
                </button>
                {reviewInvalid ? (
                  <button
                    type="button"
                    className={`${btnPrimary} h-11 flex-1`}
                    onClick={closeReview}
                  >
                    Close and review again
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`${frozen.draft.side === "buy" ? btnSafe : btnDanger} h-11 flex-1`}
                    disabled={!canSubmit}
                    onClick={handleConfirm}
                  >
                    {submitLabel}
                  </button>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
