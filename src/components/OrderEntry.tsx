"use client";

import { useMemo, useState } from "react";
import { formatMoney, UNAVAILABLE } from "@/lib/format";
import { ageMs } from "@/lib/market-data/selectors";
import type { MarketInfo } from "@/lib/market-data/types";
import { displayOrderCost, estimateOrderCost } from "@/lib/trading/risk";
import type { NewOrderDraft, PlacedOrderOutcome } from "@/lib/trading/useTrading";
import { validateOrder } from "@/lib/trading/validation";
import type { OrderSide, OrderType, Position } from "@/lib/trading/types";
import { OrderSummary } from "@/components/OrderSummary";
import { btnDanger, btnGhost, btnSafe, input, panel } from "@/components/ui/styles";

const SKIP_CONFIRM_KEY = "noirwire-terminal-skip-order-confirm";
const SESSION_CONFIRMED_KEY = "noirwire-terminal-session-order-confirmed";

function readFlag(storage: Storage | null, key: string): boolean {
  if (!storage) return false;
  return storage.getItem(key) === "1";
}

export function OrderEntry({
  market,
  mark,
  now,
  hasWallet,
  availableNusd,
  position,
  placeOrder,
  onOrderPlaced,
}: {
  market: MarketInfo | undefined;
  mark: { price: string; time: number } | null;
  now: number;
  hasWallet: boolean;
  availableNusd: string | null;
  position: Position | null;
  placeOrder: (draft: NewOrderDraft) => Promise<PlacedOrderOutcome>;
  onOrderPlaced: (outcome: PlacedOrderOutcome, draft: NewOrderDraft) => void;
}) {
  const isPerp = market?.kind === "perp";
  const [side, setSide] = useState<OrderSide>("buy");
  const [orderType, setOrderType] = useState<OrderType>("market");
  const [quantityText, setQuantityText] = useState("");
  const [limitPriceText, setLimitPriceText] = useState("");
  /** Overrides the computed default once the trader edits the field by hand. */
  const [protectionPriceOverride, setProtectionPriceOverride] = useState<string | null>(null);
  const [leverage, setLeverage] = useState(1);
  const [reduceOnly, setReduceOnly] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [skipFuture, setSkipFuture] = useState(false);

  const storage = typeof window === "undefined" ? null : window.localStorage;
  const sessionStorageRef = typeof window === "undefined" ? null : window.sessionStorage;

  const defaultProtectionPrice = useMemo(() => {
    if (!mark || !market) return "";
    const base = Number(mark.price);
    if (!Number.isFinite(base)) return "";
    const slippage = side === "buy" ? 1.01 : 0.99;
    return (base * slippage).toFixed(market.priceDecimals);
  }, [mark, market, side]);
  const protectionPriceText = protectionPriceOverride ?? defaultProtectionPrice;

  const draft: NewOrderDraft | null = market
    ? {
        market: market.id,
        side,
        orderType,
        quantity: quantityText,
        limitPrice: orderType === "limit" ? limitPriceText : undefined,
        protectionPrice: orderType === "market" ? protectionPriceText : undefined,
        leverage: isPerp ? leverage : undefined,
        reduceOnly: isPerp ? reduceOnly : undefined,
        timeInForce: orderType === "limit" ? "gtc" : undefined,
      }
    : null;

  const validation = market && draft ? validateOrder(draft, market) : null;

  const estimatePrice = orderType === "market" ? mark?.price : limitPriceText;
  const estimate = useMemo(() => {
    if (!market || !estimatePrice || !quantityText) return null;
    try {
      return estimateOrderCost({
        side,
        quantity: quantityText,
        price: estimatePrice,
        leverage: isPerp ? leverage : 1,
        takerFeeBps: market.takerFeeBps,
      });
    } catch {
      return null;
    }
  }, [market, estimatePrice, quantityText, side, leverage, isPerp]);

  const estimateDisplay =
    market && estimate ? displayOrderCost(estimate, market.priceDecimals) : null;
  const markAge = mark ? ageMs(mark.time, now) : null;
  const noFunds = hasWallet && availableNusd !== null && Number(availableNusd) <= 0;

  const canSubmit = hasWallet && !noFunds && !!market && !!validation?.valid && !submitting;

  async function runSubmit() {
    if (!draft) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const outcome = await placeOrder(draft);
      onOrderPlaced(outcome, draft);
      if (outcome.result.status === "rejected") {
        setSubmitError(outcome.result.reason ?? "Rejected");
      } else {
        setQuantityText("");
        setLimitPriceText("");
        setProtectionPriceOverride(null);
      }
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Could not reach the venue");
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmitClick() {
    if (!canSubmit) return;
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
    return <div className={`${panel} text-faint p-4 text-[13px]`}>Loading market settings.</div>;
  }

  const actionWord = isPerp ? (side === "buy" ? "long" : "short") : side === "buy" ? "buy" : "sell";
  const submitLabel = `Place test ${actionWord}`;

  return (
    <div className={`${panel} flex flex-col gap-4 p-4`}>
      <div className="flex gap-2" role="group" aria-label="Side">
        <button
          type="button"
          aria-pressed={side === "buy"}
          onClick={() => setSide("buy")}
          className={`${side === "buy" ? btnSafe : btnGhost} h-11 flex-1`}
        >
          {isPerp ? "Long" : "Buy"}
        </button>
        <button
          type="button"
          aria-pressed={side === "sell"}
          onClick={() => setSide("sell")}
          className={`${side === "sell" ? btnDanger : btnGhost} h-11 flex-1`}
        >
          {isPerp ? "Short" : "Sell"}
        </button>
      </div>

      <div className="flex gap-2" role="group" aria-label="Order type">
        {(["market", "limit"] as OrderType[]).map((type) => (
          <button
            key={type}
            type="button"
            aria-pressed={orderType === type}
            onClick={() => setOrderType(type)}
            className={`rounded-tile min-h-11 flex-1 border px-3 text-[13px] capitalize ${
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
        <label className="text-faint text-[12px]" htmlFor="order-quantity">
          Quantity ({market.baseSymbol})
        </label>
        <input
          id="order-quantity"
          className={`${input} mt-1`}
          inputMode="decimal"
          value={quantityText}
          onChange={(event) => setQuantityText(event.target.value)}
        />
        {validation?.errors.quantity && (
          <p role="alert" className="text-danger mt-1 text-[12px]">
            {validation.errors.quantity}
          </p>
        )}
      </div>

      {orderType === "limit" && (
        <div>
          <label className="text-faint text-[12px]" htmlFor="order-limit-price">
            Limit price ({market.quoteSymbol})
          </label>
          <input
            id="order-limit-price"
            className={`${input} mt-1`}
            inputMode="decimal"
            value={limitPriceText}
            onChange={(event) => setLimitPriceText(event.target.value)}
          />
          {validation?.errors.limitPrice && (
            <p role="alert" className="text-danger mt-1 text-[12px]">
              {validation.errors.limitPrice}
            </p>
          )}
        </div>
      )}

      {orderType === "market" && (
        <div>
          <label className="text-faint text-[12px]" htmlFor="order-protection-price">
            Protection price ({market.quoteSymbol})
          </label>
          <input
            id="order-protection-price"
            className={`${input} mt-1`}
            inputMode="decimal"
            value={protectionPriceText}
            onChange={(event) => setProtectionPriceOverride(event.target.value)}
          />
          {validation?.errors.protectionPrice && (
            <p role="alert" className="text-danger mt-1 text-[12px]">
              {validation.errors.protectionPrice}
            </p>
          )}
        </div>
      )}

      {isPerp && (
        <div>
          <label className="text-faint flex justify-between text-[12px]" htmlFor="order-leverage">
            <span>Leverage</span>
            <span className="tnum text-ink">{leverage}x</span>
          </label>
          <input
            id="order-leverage"
            type="range"
            min={1}
            max={market.maxLeverage}
            step={1}
            value={leverage}
            onChange={(event) => setLeverage(Number(event.target.value))}
            className="mt-2 w-full"
          />
          {validation?.errors.leverage && (
            <p role="alert" className="text-danger mt-1 text-[12px]">
              {validation.errors.leverage}
            </p>
          )}
          <label className="text-dim mt-3 flex items-center gap-2 text-[12px]">
            <input
              type="checkbox"
              checked={reduceOnly}
              disabled={!position}
              onChange={(event) => setReduceOnly(event.target.checked)}
            />
            Reduce only{!position ? " (no position to reduce)" : ""}
          </label>
          <p className="text-faint mt-2 text-[11px]">Cross margin.</p>
        </div>
      )}

      <OrderSummary side={side} isPerp={!!isPerp} display={estimateDisplay} markAgeMs={markAge} />

      <p className="text-faint text-[12px]">
        Available: {availableNusd !== null ? formatMoney(availableNusd) : UNAVAILABLE}
      </p>

      {noFunds && <p className="text-warning text-[13px]">Get test funds to trade.</p>}
      {!hasWallet && <p className="text-dim text-[13px]">Create a test wallet to trade.</p>}

      <button
        type="button"
        className={`${side === "buy" ? btnSafe : btnDanger} h-12`}
        disabled={!canSubmit}
        onClick={handleSubmitClick}
      >
        {submitting ? "Submitting…" : submitLabel}
      </button>

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
          <div className={`${panel} w-full max-w-sm p-5`}>
            <p className="text-ink-strong text-[15px] font-medium">Confirm {submitLabel}</p>
            <OrderSummary
              side={side}
              isPerp={!!isPerp}
              display={estimateDisplay}
              markAgeMs={markAge}
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
