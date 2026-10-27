"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatDecimal, formatMoney, formatRelativeAge, UNAVAILABLE } from "@/lib/format";
import { ageMs, isStale, STALE_MARK_MS } from "@/lib/market-data/selectors";
import { priceDecimalsOf, sizeDecimalsOf } from "@/lib/market-data/precision";
import type { MarketInfo } from "@/lib/market-data/types";
import { isMainnetBuild } from "@/lib/network";
import { browserLocalStorage } from "@/lib/wallet";
import { limitSentAsIoc } from "@/lib/trading/orderType";
import {
  limitLineFor,
  priceAtTick,
  sliderPosition,
  tickSlider,
  type LimitLine,
} from "@/lib/trading/limitLine";
import { needsAcknowledgement, recordAcknowledgement } from "@/lib/trading/realMoneyAck";
import {
  offersTestFunds,
  placeLabel,
  sideWord,
  TEST_ONLY_COPY,
  tradeGateLabel,
  walletlessAction,
  type TradeGate,
} from "@/lib/trading/uiRules";
import { fromFixedPoint, toFixedPoint } from "@/lib/trading/decimal";
import { displayOrderCost, estimateOrderCost } from "@/lib/trading/risk";
import {
  orderFunds,
  staleMarkBlocks,
  staleReduceOnlyNotice,
  unknownCollateralBlocks,
} from "@/lib/trading/sizing";
import {
  amountForPercent,
  displayBase,
  estimateLiquidation,
  LEVERAGE_STEP,
  leverageLabel,
  maxAmount,
  maxSpotSellAmount,
  parseAmount,
  sizeFromAmount,
} from "@/lib/trading/ticketSizing";
import type { PlacedOrderOutcome } from "@/lib/trading/useTrading";
import type { UnknownHold } from "@/lib/rollup/accountMemory";
import { OrderOutcomeUnknownError } from "@/lib/trading/unknownOutcome";
import { userMessageLine } from "@/lib/userMessage";
import { describeFieldError, markMovedMaterially, validateOrder } from "@/lib/trading/validation";
import { needsSpotTransfer } from "@/lib/trading/spotTransfer";
import {
  availableLabel,
  isAvailableUnknown,
  transferableAmount,
} from "@/lib/trading/balanceDisplay";
import type {
  Balance,
  FundOutcome,
  NewOrderInput,
  OpenOrder,
  Position,
  Side,
  SpotAssets,
} from "@/lib/trading/types";
import { marketDisplayName } from "@/lib/market-data/displayName";
import type { OrderDescriptor } from "@/components/WitnessRail";
import { ConfirmOrderDialog, RealMoneyDialog, type FrozenOrder } from "@/components/OrderDialogs";
import { OrderSummary, type SummaryRow } from "@/components/OrderSummary";
import { TransferControl, type TransferFn } from "@/components/TransferControl";
import {
  btnDanger,
  btnGhost,
  btnPrimary,
  btnSafe,
  input,
  rangeBrand,
} from "@/components/ui/styles";

const PERCENT_SHORTCUTS = [25, 50, 100];
const GOOD_FOR_OPTIONS = [
  { value: "untilCancelled", label: "Until cancelled" },
  { value: "1m", label: "1 minute" },
  { value: "1h", label: "1 hour" },
] as const;

type ReasonTone = "neutral" | "warning" | "error";

const REASON_TONE_CLASS: Record<ReasonTone, string> = {
  neutral: "text-dim",
  warning: "text-warning",
  error: "text-danger",
};

function fixedPointOrZero(text: string): bigint {
  try {
    return toFixedPoint(text);
  } catch {
    return 0n;
  }
}

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
  openOrders,
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
  ownerAddress,
  setup,
  gate,
  makersListed,
  onLimitLineChange,
}: {
  /** Told the draft limit price and side while the form is a limit order with a valid price, null otherwise; the chart draws it. */
  onLimitLineChange?: (line: LimitLine | null) => void;
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
  /** The trader's resting orders; those on this market count toward the margin an order adds. */
  openOrders?: OpenOrder[];
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
  /** Phone only: the ticket sits in the page flow in a card instead of filling a scrolling panel. */
  compact?: boolean;
  /** The connected owner's address; the real-money acknowledgement is remembered under it. Empty with no wallet. */
  ownerAddress: string;
  /** Mainnet: the account and trading-keys setup, shown above the form. */
  setup?: ReactNode;
  /** Mainnet: why no order can be placed yet (account not open, keys not ready). */
  gate: TradeGate | null;
  /** This market lets only listed makers rest orders: a Limit is sent as immediate-or-cancel. */
  makersListed: boolean;
}) {
  const mainnet = isMainnetBuild();
  const testCopy = mainnet ? null : TEST_ONLY_COPY;
  const isPerp = market?.kind === "perp";
  const [side, setSide] = useState<Side>("buy");
  const [orderType, setOrderType] = useState<"market" | "limit">("market");
  const [amountText, setAmountText] = useState("");
  // A size typed (or prefilled by a dock Close/Reduce) in the market's own
  // units; while set, it replaces the size derived from amount and leverage.
  const [quantityOverride, setQuantityOverride] = useState<string | null>(null);
  const [priceOverride, setPriceOverride] = useState<string | null>(null);
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
  const [frozen, setFrozen] = useState<FrozenOrder | null>(null);
  const [openAfterPrefill, setOpenAfterPrefill] = useState(false);
  const [showAck, setShowAck] = useState(false);
  const [ackedBy, setAckedBy] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const amountInputRef = useRef<HTMLInputElement>(null);
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
    setQuantityOverride(prefillRequest.size);
    setAmountText("");
    setPriceOverride(null);
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
  const tickSize = market ? Number(market.tickSize) : NaN;
  const markNumber = mark ? Number(mark.price) : NaN;
  const slider = tickSlider(markNumber, tickSize);
  const limitLine = limitLineFor({ orderType, priceText, side });
  const linePrice = limitLine?.price ?? null;
  const lineSide = limitLine?.side ?? null;
  useEffect(() => {
    onLimitLineChange?.(
      linePrice === null || lineSide === null ? null : { price: linePrice, side: lineSide },
    );
  }, [onLimitLineChange, linePrice, lineSide]);
  useEffect(() => () => onLimitLineChange?.(null), [onLimitLineChange]);

  const baseUnit = spotAssets?.base ?? market?.base ?? "";
  const baseName = displayBase(baseUnit);
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

  const isSpotSell = !isPerp && side === "sell";
  const effectiveLeverage =
    isPerp && market ? Math.min(Math.max(leverage, 1), market.maxLeverage) : 1;
  // The price the amount is sized at: the mark for a market order, the typed
  // price for a limit. The price field's value on a market order is only the
  // worst-case bound the order may fill at.
  const referencePrice = orderType === "market" ? (mark?.price ?? "") : priceText;

  const derivedQuantity = market
    ? sizeFromAmount({
        amount: amountText,
        leverage: effectiveLeverage,
        price: referencePrice,
        lotSize: market.lotSize,
      })
    : "";
  const quantityText = quantityOverride ?? derivedQuantity;

  const maxAmountText = useMemo(() => {
    if (!market || !referencePrice) return "0.00";
    if (isSpotSell) return maxSpotSellAmount(availableBase, referencePrice);
    return maxAmount({
      available: availableQuote,
      leverage: effectiveLeverage,
      // The venue's margin requirement is always the market's fixed ratio
      // (maxLeverage); the slider only sizes the position, see `orderFunds`.
      maxLeverage: market.maxLeverage,
      boundPrice: priceText || referencePrice,
      refPrice: referencePrice,
    });
  }, [
    market,
    referencePrice,
    isSpotSell,
    availableBase,
    availableQuote,
    effectiveLeverage,
    priceText,
  ]);

  const sentAsIoc = limitSentAsIoc(orderType, makersListed, isPerp && reduceOnly);
  const draft: NewOrderInput | null = market
    ? {
        market: market.id,
        side,
        type: orderType,
        price: priceText,
        size: quantityText,
        reduceOnly: isPerp && reduceOnly ? true : undefined,
        goodFor: supportsGoodFor && orderType === "limit" && !sentAsIoc ? goodFor : undefined,
      }
    : null;

  const estimate = useMemo(() => {
    if (!market || !referencePrice || !quantityText.trim()) return null;
    try {
      return estimateOrderCost({
        side,
        quantity: quantityText,
        price: referencePrice,
        leverage: isPerp ? market.maxLeverage : 1,
        maxLeverage: market.maxLeverage,
      });
    } catch {
      return null;
    }
  }, [market, referencePrice, quantityText, side, isPerp]);

  const estimateDisplay = market && estimate ? displayOrderCost(estimate, priceDecimals) : null;

  const exposure = useMemo(() => {
    if (!market || market.kind !== "perp") return undefined;
    const resting = (openSide: Side) =>
      (openOrders ?? [])
        .filter((order) => order.market === market.id && order.side === openSide)
        .reduce((sum, order) => sum + toFixedPoint(order.remainingSize), 0n);
    return {
      position: position?.size ?? "0",
      openBids: fromFixedPoint(resting("buy"), 9),
      openAsks: fromFixedPoint(resting("sell"), 9),
    };
  }, [market, position, openOrders]);

  const markPrice = mark?.price;
  const funds = useMemo(() => {
    if (!market || !priceText || !quantityText.trim()) return null;
    try {
      return orderFunds({
        mode: market.kind,
        side,
        quantity: quantityText,
        price: priceText,
        markPrice,
        maxLeverage: market.maxLeverage,
        availableQuote,
        availableBase,
        exposure,
        reduceOnly: isPerp && reduceOnly,
      });
    } catch {
      return null;
    }
  }, [
    market,
    priceText,
    markPrice,
    quantityText,
    side,
    availableQuote,
    availableBase,
    exposure,
    isPerp,
    reduceOnly,
  ]);

  const staleBlock = staleMarkBlocks({
    markStale,
    isPerp,
    reduceOnly,
    reduceOnlyGrows: funds?.reduceOnlyGrows,
  });
  const staleMarkAllowed = markStale && !staleBlock;
  const validation =
    market && draft ? validateOrder(draft, market, mark, now, staleMarkAllowed) : null;

  const leftAvailable =
    funds && !funds.shortfall && !isSpotSell
      ? fromFixedPoint(toFixedPoint(availableQuote) - funds.requiredQuote, 2)
      : null;

  const summaryRows: SummaryRow[] | null = estimateDisplay
    ? [
        {
          label: "Position size",
          value: `${formatDecimal(quantityText, sizeDecimals)} ${baseName} · ${money(estimateDisplay.notional)}`,
        },
        ...(isPerp
          ? [
              {
                label: "Margin used",
                value: money(
                  funds ? fromFixedPoint(funds.marginQuote, 2) : estimateDisplay.initialMargin,
                ),
              },
            ]
          : []),
        { label: "Fee", value: money(estimateDisplay.fee) },
        ...(orderType === "market" && priceText
          ? [
              {
                label: side === "buy" ? "Fills up to" : "Fills down to",
                value: `${formatDecimal(priceText, priceDecimals)} ${quoteUnit}`.trim(),
              },
            ]
          : []),
        ...(leftAvailable !== null
          ? [{ label: "Left available", value: money(leftAvailable) }]
          : []),
      ]
    : null;

  const noOtherPosition = !position || Number(position.size) === 0;
  const liquidation =
    isPerp && noOtherPosition && !reduceOnly && !availableUnknown && quantityText.trim()
      ? estimateLiquidation({
          side,
          quantity: quantityText,
          entryPrice: referencePrice,
          collateral: availableQuote,
          priceDecimals,
        })
      : null;

  const shortfall = funds?.shortfall ?? null;
  const unaffordable = shortfall !== null;

  const amountEntered = amountText.trim() !== "";
  const amountValue = parseAmount(amountText);
  const amountInvalid = quantityOverride === null && amountEntered && amountValue === null;
  // A perp order's own funds check is the venue's account-wide one, so once it
  // passes the amount cannot also be held to the free balance (a close needs none).
  const perpFundsCovered = isPerp && funds !== null && funds.shortfall === null;
  const amountOverAvailable =
    quantityOverride === null &&
    amountValue !== null &&
    !perpFundsCovered &&
    amountValue > (isSpotSell ? fixedPointOrZero(maxAmountText) : fixedPointOrZero(availableQuote));
  const amountTooSmall =
    quantityOverride === null && amountValue !== null && derivedQuantity === "";

  const openSize = Number(position?.size ?? 0);
  const closesOpenPosition =
    isPerp && ((side === "sell" && openSize > 0) || (side === "buy" && openSize < 0));
  const availableBlocks = unknownCollateralBlocks({
    availableUnknown,
    isPerp,
    reduceOnly,
    reduceOnlyGrows: funds?.reduceOnlyGrows,
  });
  const accountUnknown = hasWallet && (!!accountError || !accountLoaded);
  const noFunds =
    hasWallet &&
    !accountUnknown &&
    !availableUnknown &&
    Number(availableQuote) <= 0 &&
    !(isSpotSell && Number(availableBase) > 0) &&
    !closesOpenPosition;

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
      collateral && !isAvailableUnknown(collateral, now)
        ? Number(transferableAmount(collateral))
        : null,
  });
  const suggestedTransferAmount = funds ? fromFixedPoint(funds.requiredQuote, 6) : undefined;

  const canSubmit =
    hasWallet &&
    !gate &&
    !accountUnknown &&
    !availableBlocks &&
    !noFunds &&
    !!market &&
    !!validation?.valid &&
    !amountOverAvailable &&
    !unaffordable &&
    !staleBlock &&
    !submitting &&
    !placeOrderPending &&
    !unknownHold;

  const confirmBlocker = (() => {
    if (!market) return null;
    if (gate) return tradeGateLabel(gate);
    if (unknownHold) return "An earlier order may have reached the venue. Check it first.";
    if (accountUnknown) return "Your account could not be read, so this order cannot be placed.";
    if (availableBlocks) return "Available collateral is unavailable until the price updates.";
    if (validation?.errors.quantity) {
      return describeFieldError(validation.errors.quantity, { ...market, base: baseName });
    }
    if (validation?.errors.price) return describeFieldError(validation.errors.price, market);
    if (staleBlock) return "Market data is too old. Wait for a fresh mark.";
    if (amountOverAvailable) return "Your amount is more than your available balance.";
    if (unaffordable) return "Your available balance no longer covers this order.";
    if (placeOrderPending) return "An order is still being checked with the venue.";
    return canSubmit ? null : "This order cannot be placed right now.";
  })();

  /** The one line that says why the order button is off, only while the form itself is what is missing. */
  const reason: { text: string; tone: ReasonTone } | null = (() => {
    if (!market || !validation) return null;
    if (!hasWallet || gate || accountUnknown || availableBlocks) return null;
    if (unknownHold || placeOrderPending || needsTransfer) return null;
    if (noFunds) {
      if (!testCopy) return { text: `Deposit ${quoteUnit || "funds"} to trade`, tone: "neutral" };
      return grantAlreadyUsed ? { text: "No funds left to trade with", tone: "neutral" } : null;
    }
    if (staleBlock) {
      return {
        text: `The price is ${markAge !== null ? formatRelativeAge(markAge) : "too"} old. Waiting for a fresh one.`,
        tone: "warning",
      };
    }
    if (orderType === "market" && !priceText) {
      return { text: "Waiting for the current price", tone: "neutral" };
    }
    if (quantityOverride !== null) {
      if (validation.errors.quantity) {
        return {
          text: describeFieldError(validation.errors.quantity, { ...market, base: baseName }),
          tone: "error",
        };
      }
    } else if (!amountEntered) {
      return { text: "Enter an amount", tone: "neutral" };
    } else if (amountInvalid) {
      return { text: "Enter an amount like 25.00", tone: "error" };
    } else if (amountOverAvailable) {
      return {
        text: isSpotSell
          ? `You hold ${formatDecimal(availableBase, sizeDecimals)} ${baseName}`
          : `More than your available ${money(availableQuote)}`,
        tone: "error",
      };
    } else if (amountTooSmall) {
      return {
        text: `Too small to trade. The minimum is ${market.lotSize} ${baseName}`,
        tone: "error",
      };
    }
    if (validation.errors.price) {
      return { text: describeFieldError(validation.errors.price, market), tone: "error" };
    }
    if (shortfall) {
      return {
        text:
          shortfall.asset === "base"
            ? `You hold ${formatDecimal(shortfall.available, sizeDecimals)} ${baseName}; this sells ${formatDecimal(shortfall.needed, sizeDecimals)}`
            : `Needs up to ${money(shortfall.needed)} for margin and fees, you have ${money(shortfall.available)}. Lower the amount or leverage`,
        tone: "error",
      };
    }
    if (staleMarkAllowed) {
      return {
        text: staleReduceOnlyNotice(markAge !== null ? formatRelativeAge(markAge) : null),
        tone: "warning",
      };
    }
    return null;
  })();

  /** What the dialog will freeze: the exact signed fields and the worst case the order can cost. */
  function freezeOrder(): FrozenOrder | null {
    if (!draft || !market || !mark) return null;
    const worstCost = isSpotSell
      ? `${formatDecimal(quantityText, sizeDecimals)} ${baseName} sold`
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
      leverage: effectiveLeverage,
      priceTyped: priceOverride !== null,
      summaryRows,
    };
  }

  /** The one entry to the confirmation, from a click and from a dock Close: nothing opens unless the order can be placed right now. */
  function openConfirm() {
    if (!canSubmit) {
      setSubmitError(confirmBlocker);
      return;
    }
    if (mainnet && needsAcknowledgement(browserLocalStorage(), ownerAddress, ackedBy)) {
      setShowAck(true);
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
    const recheck = validateOrder(order.draft, market, mark, now, staleMarkAllowed);
    const marginExpired = unknownCollateralBlocks({
      availableUnknown: isPerp && isAvailableUnknown(collateral, Math.max(now, Date.now())),
      isPerp,
      reduceOnly: order.draft.reduceOnly === true,
      reduceOnlyGrows: funds?.reduceOnlyGrows,
    });
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
        setAmountText("");
        setQuantityOverride(null);
        setPriceOverride(null);
      }
      // The panel must always start at its top (the side/type buttons were
      // found scrolled out of view after a fill in the second-pass review):
      // a fill grows the summary above the button, which can leave the
      // scroll position mid-panel on the next render.
      containerRef.current?.parentElement?.scrollTo({ top: 0 });
    } catch (error) {
      if (error instanceof OrderOutcomeUnknownError) {
        onOrderUnknown(descriptor, error.hold);
      } else {
        setSubmitError(userMessageLine(error, { nothingSent: true }));
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function focusFirstInvalid() {
    if (!quantityText || validation?.errors.quantity) amountInputRef.current?.focus();
    else if (validation?.errors.price) priceInputRef.current?.focus();
  }

  function handlePrimaryClick() {
    if (!walletReady || accountUnknown) return;
    if (!hasWallet) {
      if (!walletLocked && !walletlessAction(mainnet).disabled) onCreateWallet();
      return;
    }
    if (needsTransfer) {
      setShowTransfer(true);
      return;
    }
    if (noFunds && !grantAlreadyUsed && !noFaucet && offersTestFunds(mainnet)) {
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
        .catch((error: unknown) => setFundMessage(userMessageLine(error, { nothingSent: true })))
        .finally(() => setFunding(false));
      return;
    }
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

  function toggleReduceOnly(checked: boolean) {
    setReduceOnly(checked);
    if (!checked) {
      setQuantityOverride(null);
      return;
    }
    const open = Number(position?.size ?? 0);
    const closes = (side === "buy" && open < 0) || (side === "sell" && open > 0);
    setQuantityOverride(closes ? String(Math.abs(open)) : "");
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

  const word = sideWord(isPerp, side);
  const submitLabel = testCopy ? placeLabel(word.toLowerCase(), mainnet) : `${word} ${baseName}`;

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
    const action = walletlessAction(mainnet);
    primaryLabel = action.label;
    primaryClass = action.disabled ? btnGhost : btnPrimary;
    primaryDisabled = action.disabled;
  } else if (gate) {
    primaryLabel = tradeGateLabel(gate);
    primaryClass = btnGhost;
    primaryDisabled = true;
  } else if (accountUnknown) {
    primaryLabel = accountError ? "Account unavailable" : "Loading account…";
    primaryClass = btnGhost;
    primaryDisabled = true;
  } else if (availableBlocks) {
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
  } else if (noFunds && (grantAlreadyUsed || !testCopy)) {
    // Nowhere left to ask for funds: the reason line under the button says
    // so, and the action stays the ordinary, disabled order button.
    primaryClass = btnGhost;
    primaryDisabled = true;
  } else if (noFunds && testCopy && noFaucet) {
    primaryLabel = testCopy.noFaucetLabel;
    primaryClass = btnGhost;
    primaryDisabled = true;
  } else if (noFunds && testCopy) {
    // The size of a grant, and whether one exists at all, is the service's
    // to say: it is only known once asked, so the offer names no amount.
    primaryLabel = testCopy.getFundsLabel;
    primaryClass = btnPrimary;
    primaryDisabled = funding;
  } else if (!canSubmit) {
    primaryClass = btnGhost;
  }

  const fundsMissing = noFunds || availableUnknown || accountUnknown || !hasWallet;
  const percentDisabled = fundsMissing || fixedPointOrZero(maxAmountText) <= 0n;
  const availableText = isSpotSell
    ? `Available ${formatDecimal(availableBase, sizeDecimals)} ${baseName}`
    : availableUnknown && collateral
      ? availableLabel(collateral, money, now)
      : confirmingFund && collateral !== undefined && Number(availableQuote) <= 0
        ? "Confirming on chain…"
        : grantAlreadyUsed
          ? `Grant used · ${money(availableQuote)} available`
          : `Available ${money(availableQuote)}`;

  return (
    <div
      ref={containerRef}
      className={`flex flex-col gap-3 p-3 ${
        compact ? "bg-surface border-line-subtle rounded-panel border" : "min-h-full"
      }`}
    >
      {setup}

      <div className="flex items-center justify-between gap-2">
        <p className="text-ink-strong text-[14px] font-medium">
          {isPerp ? `${baseName} Perpetual` : marketDisplayName(market.id)}
        </p>
        <select
          aria-label="Order type"
          className="text-dim hover:text-ink focus-visible:outline-line-strong cursor-pointer rounded-sm bg-transparent py-1 text-[12px]"
          value={orderType}
          onChange={(event) => setOrderType(event.target.value as "market" | "limit")}
        >
          <option value="market">Market</option>
          <option value="limit">Limit</option>
        </select>
      </div>

      <div
        className="bg-surface-raised border-line flex gap-0.5 rounded-full border p-0.5"
        role="group"
        aria-label="Side"
      >
        {(["buy", "sell"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={side === value}
            onClick={() => setSide(value)}
            className={`h-9 flex-1 rounded-full text-[13px] font-medium transition-colors ${
              side === value
                ? value === "buy"
                  ? "bg-safe text-(--color-base)"
                  : "bg-danger text-(--color-base)"
                : "text-dim hover:text-ink"
            }`}
          >
            {sideWord(isPerp, value)}
          </button>
        ))}
      </div>
      {sentAsIoc && (
        <p className="text-faint -mt-2 text-[11px]">
          This limit order fills now or cancels. Resting orders are not open to every account yet.
        </p>
      )}

      {quantityOverride === null ? (
        <div>
          <div className="flex items-baseline justify-between gap-2">
            <label className="text-faint text-[12px]" htmlFor="order-amount">
              Amount{quoteUnit && ` (${quoteUnit})`}
            </label>
            <span className="text-faint tnum text-[11px]">{availableText}</span>
          </div>
          <div className="relative mt-1.5">
            <input
              ref={amountInputRef}
              id="order-amount"
              className={`${input} tnum h-12 pr-16 text-[20px]`}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              value={amountText}
              onChange={(event) => setAmountText(event.target.value)}
            />
            <span className="text-faint pointer-events-none absolute inset-y-0 right-3 flex items-center text-[12px]">
              {quoteUnit}
            </span>
          </div>
          <div className="mt-2 flex gap-1.5" role="group" aria-label="Amount shortcuts">
            {PERCENT_SHORTCUTS.map((pct) => (
              <button
                key={pct}
                type="button"
                disabled={percentDisabled}
                className={`${btnGhost} h-8 min-h-8 flex-1 text-[12px]`}
                onClick={() => setAmountText(amountForPercent(maxAmountText, pct))}
              >
                {pct === 100 ? "Max" : `${pct}%`}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div>
          <div className="flex items-baseline justify-between gap-2">
            <label className="text-faint text-[12px]" htmlFor="order-size">
              Size ({baseName})
            </label>
            <button
              type="button"
              className="text-faint hover:text-ink text-[11px] underline"
              onClick={() => setQuantityOverride(null)}
            >
              Enter an amount instead
            </button>
          </div>
          <input
            ref={amountInputRef}
            id="order-size"
            className={`${input} tnum mt-1.5 h-12 text-[20px]`}
            inputMode="decimal"
            autoComplete="off"
            value={quantityOverride}
            onChange={(event) => setQuantityOverride(event.target.value)}
          />
        </div>
      )}

      {isPerp && quantityOverride === null && (
        <div>
          <div className="flex items-end justify-between">
            <label className="text-faint text-[12px]" htmlFor="order-leverage">
              Leverage
            </label>
            <span className="tnum text-ink-strong text-[26px] leading-none font-medium">
              {leverageLabel(effectiveLeverage)}
            </span>
          </div>
          <input
            id="order-leverage"
            type="range"
            min={1}
            max={market.maxLeverage}
            step={LEVERAGE_STEP}
            value={effectiveLeverage}
            onChange={(event) => setLeverage(Number(event.target.value))}
            className={`${rangeBrand} mt-3`}
          />
          {liquidation && (
            <p className="text-dim tnum mt-2 text-[12px]">
              {liquidation.kind === "price"
                ? `Liquidates near ${formatDecimal(liquidation.price, priceDecimals)} ${quoteUnit} (est.)`
                : "No liquidation price at this size (est.)"}
            </p>
          )}
        </div>
      )}

      {orderType === "limit" && (
        <div>
          <label className="text-faint text-[12px]" htmlFor="order-price">
            Limit price{quoteUnit && ` (${quoteUnit})`}
          </label>
          <input
            ref={priceInputRef}
            id="order-price"
            className={`${input} tnum mt-1.5`}
            inputMode="decimal"
            value={priceText}
            onChange={(event) => setPriceOverride(event.target.value)}
          />
          {slider && (
            <input
              type="range"
              aria-label="Price slider, within 10 percent of the current price"
              min={slider.min}
              max={slider.max}
              step={1}
              value={sliderPosition(priceText, markNumber, tickSize, slider)}
              onChange={(event) =>
                setPriceOverride(priceAtTick(Number(event.target.value), tickSize, priceDecimals))
              }
              className={`${rangeBrand} mt-3`}
            />
          )}
          <p className="text-faint mt-1 text-[11px]">Fills only at this price or better.</p>
        </div>
      )}

      {supportsGoodFor && orderType === "limit" && !sentAsIoc && (
        <div>
          <label className="text-faint text-[12px]" htmlFor="order-good-for">
            Good for
          </label>
          <select
            id="order-good-for"
            className={`${input} mt-1.5`}
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

      {isPerp && position && Number(position.size) !== 0 && (
        <label className="text-dim flex items-center gap-2 text-[12px]">
          <input
            type="checkbox"
            checked={reduceOnly}
            onChange={(event) => toggleReduceOnly(event.target.checked)}
          />
          Reduce only
        </label>
      )}

      {accountUnknown && accountError && (
        <p role="alert" className="text-danger text-[12px]">
          Could not read your account, so your balance is unknown (not zero). Trading
          {testCopy ? testCopy.accountErrorLead : " is"} off until it loads. Reload the page to try
          again.
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

      <OrderSummary rows={summaryRows} />

      <div className="bg-surface sticky bottom-0 z-10 -mx-3 mt-auto -mb-3 flex flex-col gap-2 px-3 pt-2 pb-3">
        <button
          type="button"
          className={`${primaryClass} h-12 w-full text-[14px]`}
          disabled={primaryDisabled}
          onClick={handlePrimaryClick}
        >
          {funding ? "Requesting…" : submitting ? "Submitting…" : primaryLabel}
        </button>

        {reason && (
          <p
            role={reason.tone === "error" ? "alert" : "status"}
            className={`${REASON_TONE_CLASS[reason.tone]} text-center text-[12px]`}
          >
            {reason.text}
          </p>
        )}

        {/* Only a genuine problem (rate limit, error) ever shows here now, and
          only while it is still true: `noFunds` turning false (funds
          landed) retires it instead of leaving it under the button
          alongside a working order form (third design review, must-fix 2). */}
        {fundMessage && noFunds && (
          <p className="text-warning text-center text-[12px]">{fundMessage}</p>
        )}
        {noFaucet && noFunds && testCopy && (
          <p className="text-dim text-center text-[12px]">{testCopy.noFaucetNotice}</p>
        )}
        {submitError && (
          <p role="alert" className="text-danger text-center text-[13px]">
            {submitError}
          </p>
        )}
      </div>

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

      {showAck && (
        <RealMoneyDialog
          onBack={() => setShowAck(false)}
          onAccept={() => {
            recordAcknowledgement(browserLocalStorage(), ownerAddress);
            setAckedBy(ownerAddress);
            setShowAck(false);
            setOpenAfterPrefill(true);
          }}
        />
      )}

      {showConfirm && frozen && (
        <ConfirmOrderDialog
          order={frozen}
          isPerp={isPerp}
          makersListed={makersListed}
          sizeDecimals={sizeDecimals}
          priceDecimals={priceDecimals}
          baseName={baseName}
          quoteUnit={quoteUnit}
          reviewInvalid={reviewInvalid}
          blocker={confirmBlocker}
          canSubmit={canSubmit}
          submitLabel={submitLabel}
          onBack={closeReview}
          onConfirm={handleConfirm}
        />
      )}
    </div>
  );
}
