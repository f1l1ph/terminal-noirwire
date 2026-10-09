"use client";

import { useMemo, useRef, useState } from "react";
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
import { maxOrderSize } from "@/lib/trading/sizing";
import type { PlacedOrderOutcome } from "@/lib/trading/useTrading";
import { describeFieldError, validateOrder } from "@/lib/trading/validation";
import type { Balance, FundOutcome, NewOrderInput, Position, Side } from "@/lib/trading/types";
import type { OrderDescriptor } from "@/components/WitnessRail";
import { OrderSummary } from "@/components/OrderSummary";
import {
  btnDanger,
  btnGhost,
  btnPrimary,
  btnSafe,
  input,
  rangeBrand,
} from "@/components/ui/styles";

const SKIP_CONFIRM_KEY = "noirwire-terminal-skip-order-confirm";
const SESSION_CONFIRMED_KEY = "noirwire-terminal-session-order-confirmed";
const PERCENT_SHORTCUTS = [25, 50, 75, 100];

function readFlag(storage: Storage | null, key: string): boolean {
  if (!storage) return false;
  return storage.getItem(key) === "1";
}

export function OrderEntry({
  market,
  mark,
  now,
  hasWallet,
  walletReady,
  balances,
  position,
  onCreateWallet,
  creatingWallet,
  onFund,
  placeOrder,
  onOrderPlaced,
}: {
  market: MarketInfo | undefined;
  mark: { price: string; time: number } | null;
  now: number;
  hasWallet: boolean;
  walletReady: boolean;
  balances: Record<string, Balance>;
  position: Position | null;
  onCreateWallet: () => void;
  creatingWallet: boolean;
  onFund: () => Promise<FundOutcome>;
  placeOrder: (input: NewOrderInput) => Promise<PlacedOrderOutcome>;
  onOrderPlaced: (outcome: PlacedOrderOutcome, descriptor: OrderDescriptor) => void;
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
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [skipFuture, setSkipFuture] = useState(false);
  const quantityInputRef = useRef<HTMLInputElement>(null);
  const priceInputRef = useRef<HTMLInputElement>(null);

  const storage = typeof window === "undefined" ? null : window.localStorage;
  const sessionStorageRef = typeof window === "undefined" ? null : window.sessionStorage;

  const priceDecimals = market ? priceDecimalsOf(market) : 2;
  const sizeDecimals = market ? sizeDecimalsOf(market) : 4;

  const defaultBoundPrice = useMemo(() => {
    if (orderType !== "market" || !mark || !market) return "";
    const base = Number(mark.price);
    if (!Number.isFinite(base)) return "";
    const slippage = side === "buy" ? 1.01 : 0.99;
    return (base * slippage).toFixed(priceDecimals);
  }, [orderType, mark, side, market, priceDecimals]);
  const priceText = priceOverride ?? defaultBoundPrice;

  const quoteBalance = market ? balances[market.quote] : undefined;
  const baseBalance = market ? balances[market.base] : undefined;
  const availableQuote = quoteBalance?.available ?? "0";
  const markStale = isStale(mark?.time, now, STALE_MARK_MS);
  const markAge = ageMs(mark?.time, now);

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
      // (maxLeverage), never the leverage slider's value; see the note by
      // requiredMarginEstimate below.
      leverage: market.maxLeverage,
      availableQuote,
      availableBase: baseBalance?.available,
      reduceOnlyMax,
    });
  }, [market, side, priceText, mark, availableQuote, baseBalance, reduceOnlyMax]);

  const draft: NewOrderInput | null = market
    ? {
        market: market.id,
        side,
        type: orderType,
        price: priceText,
        size: quantityText,
        reduceOnly: isPerp && reduceOnly ? true : undefined,
      }
    : null;

  const validation = market && draft ? validateOrder(draft, market) : null;
  const quantityError =
    quantityTouched && validation?.errors.quantity
      ? describeFieldError(validation.errors.quantity, market!)
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

  /**
   * sim-noirwire has no per-order leverage field: a perp's margin
   * requirement is always the market's fixed ratio (equivalent to its
   * advertised `maxLeverage`), computed from total account exposure, never
   * from what the leverage slider is set to. Affordability must check
   * against that fixed requirement, not the display estimate above, or an
   * order the venue would accept could show as blocked here (or the other
   * way around).
   */
  const requiredMarginEstimate = useMemo(() => {
    if (!market || !priceText || !quantityText.trim()) return null;
    try {
      return estimateOrderCost({
        side,
        quantity: quantityText,
        price: priceText,
        leverage: market.maxLeverage,
        maxLeverage: market.maxLeverage,
      });
    } catch {
      return null;
    }
  }, [market, priceText, quantityText, side]);

  /** `available - (fee + whatever the order needs reserved)`, in the same integer fixed-point arithmetic as every other order number here. Negative means the order is not affordable yet. */
  const remainingAvailable = useMemo(() => {
    if (!requiredMarginEstimate || !market) return availableQuote;
    const needed =
      market.kind === "perp"
        ? requiredMarginEstimate.fee + requiredMarginEstimate.initialMargin
        : requiredMarginEstimate.notional + requiredMarginEstimate.fee;
    try {
      const remaining = toFixedPoint(availableQuote) - needed;
      return fromFixedPoint(remaining, 6);
    } catch {
      return availableQuote;
    }
  }, [requiredMarginEstimate, market, availableQuote]);

  const unaffordable = requiredMarginEstimate !== null && Number(remainingAvailable) < 0;
  const staleBlock = markStale && orderType === "market";

  const noFunds = hasWallet && Number(availableQuote) <= 0;

  const canSubmit =
    hasWallet &&
    !noFunds &&
    !!market &&
    !!validation?.valid &&
    !unaffordable &&
    !staleBlock &&
    !submitting;

  async function runSubmit() {
    if (!draft || !market) return;
    setSubmitting(true);
    setSubmitError(null);
    const descriptor: OrderDescriptor = {
      market: market.id,
      side,
      type: orderType,
      price: priceText,
      size: quantityText,
      baseUnit: market.base,
      quoteUnit: market.quote,
      priceDecimals,
      sizeDecimals,
    };
    try {
      const outcome = await placeOrder(draft);
      onOrderPlaced(outcome, descriptor);
      if (outcome.result.status !== "rejected") {
        setQuantityText("");
        setQuantityTouched(false);
        setPriceOverride(null);
        setPriceTouched(false);
      }
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Could not reach the venue");
    } finally {
      setSubmitting(false);
    }
  }

  function focusFirstInvalid() {
    if (validation?.errors.quantity) quantityInputRef.current?.focus();
    else if (validation?.errors.price) priceInputRef.current?.focus();
  }

  function handlePrimaryClick() {
    if (!walletReady) return;
    if (!hasWallet) {
      onCreateWallet();
      return;
    }
    if (noFunds) {
      setFunding(true);
      setFundMessage(null);
      onFund()
        .then((outcome) => {
          if (outcome.kind === "alreadyFunded") {
            setFundMessage("This wallet already received its one-time grant.");
          } else if (outcome.kind === "rateLimited") {
            setFundMessage(
              "Too many funding requests from this network right now. Try again shortly.",
            );
          } else if (outcome.kind === "error") {
            setFundMessage(outcome.message);
          } else {
            setFundMessage(null);
          }
        })
        .finally(() => setFunding(false));
      return;
    }
    setQuantityTouched(true);
    setPriceTouched(true);
    if (!canSubmit) {
      focusFirstInvalid();
      return;
    }
    const skip = readFlag(storage, SKIP_CONFIRM_KEY);
    const confirmedThisSession = readFlag(sessionStorageRef, SESSION_CONFIRMED_KEY);
    if (skip || confirmedThisSession) {
      void runSubmit();
      return;
    }
    setShowConfirm(true);
  }

  function handleConfirm() {
    sessionStorageRef?.setItem(SESSION_CONFIRMED_KEY, "1");
    if (skipFuture) storage?.setItem(SKIP_CONFIRM_KEY, "1");
    setShowConfirm(false);
    void runSubmit();
  }

  if (!market) {
    return (
      <div className="bg-surface border-line-subtle rounded-panel text-faint border p-4 text-[13px]">
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
  } else if (!hasWallet) {
    primaryLabel = "Create test wallet";
    primaryClass = btnPrimary;
    primaryDisabled = creatingWallet;
  } else if (noFunds) {
    primaryLabel = "Get 5,000 test nUSD";
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
    <div className="bg-surface border-line-subtle rounded-panel flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      <p className="text-ink-strong text-[13px] font-medium">Trade {market.id} · TEST NETWORK</p>
      <p className="text-faint text-[11px]">
        {market.kind === "perp" ? "Perpetual, cross margin" : "Spot"}
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

      <p className="text-faint text-[12px]">
        Available: {formatMoney(availableQuote)}
        {market.kind === "spot" && side === "sell" && (
          <span>
            {" "}
            · {formatDecimal(baseBalance?.available ?? "0", sizeDecimals)} {market.base}
          </span>
        )}
      </p>

      <div>
        <label className="text-faint text-[12px]" htmlFor="order-quantity">
          Quantity ({market.base})
        </label>
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
          <p id="order-quantity-error" role="alert" className="text-danger mt-1 text-[12px]">
            {quantityError}
          </p>
        ) : (
          <p id="order-quantity-hint" className="text-faint mt-1 text-[11px]">
            Min {market.lotSize} {market.base} · step {market.lotSize}
          </p>
        )}
        <div className="mt-2 flex gap-1" role="group" aria-label="Quantity shortcuts">
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
            : "Limit price"}{" "}
          ({market.quote})
        </label>
        <input
          ref={priceInputRef}
          id="order-price"
          className={`${input} mt-1`}
          inputMode="decimal"
          placeholder={orderType === "limit" ? "0.00" : undefined}
          value={priceText}
          aria-describedby={priceError ? "order-price-error" : "order-price-hint"}
          onBlur={() => setPriceTouched(true)}
          onChange={(event) => {
            setPriceOverride(event.target.value);
            setPriceTouched(true);
          }}
        />
        {priceError ? (
          <p id="order-price-error" role="alert" className="text-danger mt-1 text-[12px]">
            {priceError}
          </p>
        ) : orderType === "market" && mark && !markStale ? (
          <p id="order-price-hint" className="text-faint mt-1 text-[11px]">
            {formatPercent(((Number(priceText) - Number(mark.price)) / Number(mark.price)) * 100)}{" "}
            from mark · mark age {markAge !== null ? formatRelativeAge(markAge) : UNAVAILABLE}
          </p>
        ) : (
          <p id="order-price-hint" className="text-faint mt-1 text-[11px]">
            Filled only at this price or better.
          </p>
        )}
      </div>

      {isPerp && (
        <div>
          <label className="text-faint flex justify-between text-[12px]" htmlFor="order-leverage">
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
            className={`${rangeBrand} mt-2`}
          />
          <p className="text-faint mt-1 text-[11px]">
            Cross margin. Sizes this estimate; the venue requires the market&apos;s fixed margin
            ratio regardless.
          </p>
          <label className="text-dim mt-2 flex items-center gap-2 text-[12px]">
            <input
              type="checkbox"
              checked={reduceOnly}
              disabled={!position || Number(position.size) === 0}
              onChange={(event) => setReduceOnly(event.target.checked)}
            />
            Reduce only{!position || Number(position.size) === 0 ? " (no position to reduce)" : ""}
          </label>
        </div>
      )}

      {staleBlock && (
        <p role="alert" className="text-warning text-[12px]">
          Market data is {markAge !== null ? formatRelativeAge(markAge) : "too"} old. Wait for a
          fresh mark.
        </p>
      )}
      {unaffordable && !staleBlock && requiredMarginEstimate && (
        <p role="alert" className="text-danger text-[12px]">
          Available {formatMoney(availableQuote)}; this order needs about{" "}
          {formatMoney(
            market.kind === "perp"
              ? String(requiredMarginEstimate.fee + requiredMarginEstimate.initialMargin)
              : String(requiredMarginEstimate.notional + requiredMarginEstimate.fee),
          )}{" "}
          including fee. Reduce quantity.
        </p>
      )}

      <OrderSummary
        side={side}
        isPerp={isPerp}
        display={estimateDisplay}
        priceDecimals={priceDecimals}
        remainingAvailable={remainingAvailable}
        now={now}
      />

      <button
        type="button"
        className={`${primaryClass} h-11 w-full`}
        disabled={primaryDisabled}
        onClick={handlePrimaryClick}
      >
        {funding ? "Requesting…" : submitting ? "Submitting…" : primaryLabel}
      </button>

      {fundMessage && <p className="text-warning text-[12px]">{fundMessage}</p>}

      {submitError && (
        <p role="alert" className="text-danger text-[13px]">
          {submitError}
        </p>
      )}

      {showConfirm && draft && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm order"
          className="bg-base/80 fixed inset-0 z-20 flex items-center justify-center p-4"
        >
          <div className="bg-surface border-line-strong rounded-panel w-full max-w-sm border p-5">
            <p className="text-ink-strong text-[14px] font-medium">
              {market.id} · {orderType === "market" ? "Market" : "Limit"} ·{" "}
              {isPerp ? (side === "buy" ? "Long" : "Short") : side === "buy" ? "Buy" : "Sell"}{" "}
              {formatDecimal(quantityText, sizeDecimals)} {market.base}
              {isPerp ? ` · ${leverage}x cross` : ""}
            </p>
            <p className="text-faint mt-1 text-[12px]">
              {orderType === "market"
                ? side === "buy"
                  ? "Max buy price "
                  : "Min sell price "
                : "Limit price "}
              {formatDecimal(priceText, priceDecimals)} {market.quote}
            </p>
            <OrderSummary
              side={side}
              isPerp={isPerp}
              display={estimateDisplay}
              priceDecimals={priceDecimals}
              remainingAvailable={remainingAvailable}
              now={now}
            />
            <label className="text-dim mt-3 flex items-center gap-2 text-[12px]">
              <input
                type="checkbox"
                checked={skipFuture}
                onChange={(event) => setSkipFuture(event.target.checked)}
              />
              Do not ask again
            </label>
            <div className="mt-4 flex gap-3">
              <button
                type="button"
                className={`${btnGhost} h-11 flex-1`}
                onClick={() => setShowConfirm(false)}
              >
                Back
              </button>
              <button
                type="button"
                className={`${side === "buy" ? btnSafe : btnDanger} h-11 flex-1`}
                onClick={handleConfirm}
              >
                {submitLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
