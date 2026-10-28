import { formatDuration } from "../format";
import type {
  CancelResult,
  OrderStatus,
  PlaceOrderResult,
  Side,
  TransferResult,
} from "../trading/types";
import {
  describeProgramError,
  describeTransactionError,
  PROGRAM_ERROR,
  WIRE_ERROR_OFFSET,
  type RefusalContext,
} from "./refusals";
import type { MarketUnits } from "./units";
import { lotsToSize } from "./units";
import {
  ALL_KEYS_BUSY_MESSAGE,
  OrderInvalid,
  OutcomeUnknown,
  RESULT_STATUS_CODE,
  TransactionFailed,
  type OrderResult,
  type Placed,
  type Settled,
  type Timing,
} from "./sdk";

const EXPIRED_NOT_PLACED_REASON =
  "Expired, not placed. The venue never ran this order; its order key is free again.";
const ALL_SLOTS_BUSY_REASON =
  "All four of this wallet's order-key slots are busy right now. Wait for one to free up, then try again.";
const NOTHING_TO_CANCEL_REASON =
  "Nothing to cancel: the order already filled, expired or was cancelled.";
const ORDER_REFUSED_REASON =
  "The exchange refused this order. Nothing was charged and nothing filled. Try again in a moment.";
const CANCEL_REFUSED_REASON =
  "The exchange did not accept the cancel. Your orders are unchanged. Try again in a moment.";
const UNRECOGNISED_RESULT_REASON =
  "The exchange gave an answer this terminal does not recognise. Check your open orders and positions before trying again.";

/** Shown when a pending call's answer never arrived, so what became of it is not known. */
export const UNCONFIRMED_OUTCOME_REASON =
  "We could not confirm what happened to this request. Check your positions and open orders before trying again. Nothing will be sent again automatically.";

/** Shown when the order keys were refused twice: another tab or device is using this account. */
export const KEYS_IN_USE_ELSEWHERE_REASON =
  "This account is being used in another tab or on another device, so this did not go through. Reload this page to carry on here. Nothing was charged.";

/** Shown when a reduce-only order was refused because the position is already gone or smaller. */
export const POSITION_ALREADY_REDUCED_REASON =
  "Your position was already closed or reduced, possibly by liquidation, so this order did not run. Check your positions and balance.";

export const UNCONFIRMED_PLACE_RESULT: PlaceOrderResult = {
  orderId: "",
  tag: "",
  status: "rejected",
  filledSize: "0",
  remainingSize: "0",
  reason: UNCONFIRMED_OUTCOME_REASON,
};

/** A failed transaction's refusal, or one written to the result ring, carrying the program's number; null for anything else. */
export function refusalNumberOf(error: unknown): number | null {
  if (!(error instanceof TransactionFailed) || error.code === null) return null;
  return error.code >= WIRE_ERROR_OFFSET ? error.code - WIRE_ERROR_OFFSET : null;
}

/** The program's number when a result is a refusal, else null. */
export function resultRefusalNumber(result: OrderResult): number | null {
  return result.status === RESULT_STATUS_CODE.refused ? result.code : null;
}

/** `keys.take()`'s own synchronous refusal, thrown before anything is sent, when every slot is already lent to another in-flight call. */
function isAllKeysBusy(error: unknown): boolean {
  return error instanceof Error && error.message === ALL_KEYS_BUSY_MESSAGE;
}

/**
 * Maps the program's own outcome (RULES.md section 3: a book-dependent
 * refusal is never an error, it is a result only the trader can read) onto
 * this terminal's existing `OrderStatus` wire enum (open / filled /
 * partiallyFilled / cancelled / rejected), so the witness rail needs no new
 * step types for rollup mode. `orderId` is the order's sequence number as a
 * decimal string when one was assigned (a resting or partially-filled
 * order), so a per-order cancel can reference it; otherwise empty.
 * `sentAtMs`/`resultAtMs` (the package's `Timing`, both `performance.now()`)
 * let the caller compute a more precise speed figure against its own click
 * timestamp than wrapping the whole call. `expiresAtMs` is this device's own
 * clock reading of when the order can no longer run (the caller's own
 * `expirySeconds` added to when it sent the call) - needed only for the
 * `unknown` branch, since neither `Placed` nor `Settled` carries it.
 * `market` words a refusal: the market's own price age limit and kind.
 */
export function placedToResult(
  placed: Placed,
  units: MarketUnits,
  sizeDecimals: number,
  expiresAtMs?: number,
  market: RefusalContext = {},
): PlaceOrderResult {
  if (placed.outcome === "unknown") {
    const unknownAtMs = Date.now();
    return {
      orderId: "",
      tag: "",
      status: "open",
      filledSize: "0",
      remainingSize: "0",
      reason: "Checking with the venue. Do not resend yet.",
      sentAtMs: placed.sentAt,
      pending: {
        expiresAtMs: expiresAtMs ?? Date.now(),
        settled: placed.settled
          .then((settled) => settledToResult(settled, units, sizeDecimals, market, unknownAtMs))
          .catch(() => UNCONFIRMED_PLACE_RESULT),
      },
    };
  }
  return settledToResult(placed, units, sizeDecimals, market);
}

/**
 * `unknownAtMs`, when given, means this result is what an `unknown` outcome
 * settled to: a `placed` branch then gets a "landed late" note (how long
 * after the device gave up it actually showed in the view).
 */
function settledToResult(
  settled: Settled,
  units: MarketUnits,
  sizeDecimals: number,
  market: RefusalContext,
  unknownAtMs?: number,
): PlaceOrderResult {
  if (settled.outcome === "expired") {
    return {
      orderId: "",
      tag: "",
      status: "rejected",
      filledSize: "0",
      remainingSize: "0",
      reason: EXPIRED_NOT_PLACED_REASON,
      sentAtMs: settled.sentAt,
    };
  }
  return ranToResult(settled.result, settled, units, sizeDecimals, market, unknownAtMs);
}

/** An order that ran, whichever way its result reached this device. */
function ranToResult(
  result: OrderResult,
  timing: Timing,
  units: MarketUnits,
  sizeDecimals: number,
  market: RefusalContext,
  unknownAtMs?: number,
): PlaceOrderResult {
  const filledSize = lotsToSize(units, result.filled, sizeDecimals);
  const restedSize = lotsToSize(units, result.rested, sizeDecimals);
  const cancelledSize = lotsToSize(units, result.cancelled, sizeDecimals);
  const orderId = result.rested > 0n || result.orderSeq > 0n ? result.orderSeq.toString() : "";

  const { status, reason } = describeStatus(result, filledSize, market);
  const landedLateNote =
    unknownAtMs !== undefined
      ? `Landed late, about ${formatDuration(Date.now() - unknownAtMs)} after the venue first seemed unresponsive.`
      : null;
  return {
    orderId,
    tag: "",
    status,
    filledSize,
    remainingSize: result.rested > 0n ? restedSize : cancelledSize,
    reason: [reason, landedLateNote].filter(Boolean).join(" ") || null,
    sentAtMs: timing.sentAt,
    resultAtMs: timing.resultAt,
  };
}

/**
 * `placeOrder` throws instead of returning an outcome for three cases:
 * `OrderInvalid` when the order would be refused on the market's own public
 * settings alone, checked before anything is signed; `TransactionFailed`
 * when the transaction landed on chain and the program refused it; and a
 * plain `Error` from `keys.take()` when every one of the four order-key
 * slots is already lent to another in-flight call. All three are certain,
 * immediate outcomes (nothing to await), mapped to the witness rail's
 * ordinary rejected state with a plain sentence, exactly like a
 * book-dependent refusal, rather than surfacing as a raw thrown error.
 * `OutcomeUnknown` is NOT handled here - it is not certain, and the caller
 * (`RollupTradingClient.placeOrder`) maps it to a pending result instead,
 * through `placeUnknownToResult`.
 */
export function thrownToResult(
  error: unknown,
  market: RefusalContext = {},
): PlaceOrderResult | null {
  if (error instanceof OrderInvalid) {
    return {
      orderId: "",
      tag: "",
      status: "rejected",
      filledSize: "0",
      remainingSize: "0",
      reason: describeOrderInvalid(error.reason),
    };
  }
  if (error instanceof TransactionFailed) {
    return {
      orderId: "",
      tag: "",
      status: "rejected",
      filledSize: "0",
      remainingSize: "0",
      reason:
        error.code === null
          ? "Refused by the venue. No fill occurred."
          : (describeTransactionError(error.code, market) ?? ORDER_REFUSED_REASON),
    };
  }
  if (isAllKeysBusy(error)) {
    return {
      orderId: "",
      tag: "",
      status: "rejected",
      filledSize: "0",
      remainingSize: "0",
      reason: ALL_SLOTS_BUSY_REASON,
    };
  }
  return null;
}

/**
 * `placeOrder` throws `OutcomeUnknown` when a send or a read failed after
 * the signed order went out: the order may still run, so this is the same
 * pending result an `unknown` outcome gets, never a reason to send again.
 * Its `settled` resolves to the order's result, or to null once it can no
 * longer run.
 */
export function placeUnknownToResult(
  error: unknown,
  units: MarketUnits,
  sizeDecimals: number,
  expiresAtMs: number,
  market: RefusalContext = {},
): PlaceOrderResult | null {
  if (!(error instanceof OutcomeUnknown)) return null;
  const unknownAtMs = Date.now();
  return {
    orderId: "",
    tag: "",
    status: "open",
    filledSize: "0",
    remainingSize: "0",
    reason: "Checking with the venue. Do not resend yet.",
    pending: {
      expiresAtMs,
      settled: error.settled
        .then((result): PlaceOrderResult => {
          if (!result) {
            return {
              orderId: "",
              tag: "",
              status: "rejected",
              filledSize: "0",
              remainingSize: "0",
              reason: EXPIRED_NOT_PLACED_REASON,
            };
          }
          return ranToResult(result, result, units, sizeDecimals, market, unknownAtMs);
        })
        .catch(() => UNCONFIRMED_PLACE_RESULT),
    },
  };
}

function describeOrderInvalid(
  reason: "SizeTooSmall" | "PriceOffTick" | "NotionalTooSmall",
): string {
  switch (reason) {
    case "SizeTooSmall":
      return "This order is smaller than the market's minimum size.";
    case "PriceOffTick":
      return "This price is not a multiple of the market's tick.";
    case "NotionalTooSmall":
      return "This order's notional is below the market's minimum.";
  }
}

function nothingFilledLead(filledAny: boolean): string {
  return filledAny ? "" : "Nothing filled. ";
}

/** The side that would have had to be resting for this order to match: a sell needs buyers. */
function counterparties(side: Side | undefined): string {
  if (side === undefined) return "orders";
  return side === "sell" ? "buyers" : "sellers";
}

/**
 * An order that matched nothing, or only part, and whose remainder was
 * cancelled. The book is private, so the cause is named only as likely: the
 * house market maker briefly has no quotes while it refreshes or is paused.
 */
function noMatchReason(filledAny: boolean, market: RefusalContext): string {
  const others = counterparties(market.side);
  if (filledAny) return `Part filled; the rest found no ${others} and was cancelled.`;
  if (market.reduceOnly) {
    return "Nothing was available to close against at that moment, so nothing filled and nothing was charged. Your position is unchanged. Try again in a few seconds.";
  }
  return `No ${others} at your price right now, so nothing filled and nothing was charged. The market maker may be refreshing its quotes. Try again in a few seconds.`;
}

/** Matching stops at the first fill the taker cannot take: too little margin, the market's open-interest cap, or the USDC guard. */
function fillCheckReason(filledAny: boolean): string {
  return `${nothingFilledLead(filledAny)}The rest was cancelled because the next fill failed a check: your margin may be too low, this market's open-interest limit may be reached, or the USDC price guard may be on. Lower the size, add collateral or try again later. Nothing was charged for the part that did not fill.`;
}

function describeStatus(
  result: OrderResult,
  filledSize: string,
  market: RefusalContext,
): { status: OrderStatus; reason: string | null } {
  const filledAny = Number(filledSize) > 0;
  switch (result.status) {
    case RESULT_STATUS_CODE.filled:
      return { status: "filled", reason: null };
    case RESULT_STATUS_CODE.rested:
      return { status: filledAny ? "partiallyFilled" : "open", reason: null };
    case RESULT_STATUS_CODE.remainderCancelled:
      return {
        status: filledAny ? "partiallyFilled" : "cancelled",
        reason: noMatchReason(filledAny, market),
      };
    case RESULT_STATUS_CODE.remainderCancelledStepLimit:
      return {
        status: filledAny ? "partiallyFilled" : "cancelled",
        reason: `${nothingFilledLead(filledAny)}The remainder was cancelled: this order crossed the venue's per-order fill limit.`,
      };
    case RESULT_STATUS_CODE.remainderCancelledBookFull:
      return {
        status: filledAny ? "partiallyFilled" : "cancelled",
        reason: `${nothingFilledLead(filledAny)}The remainder was cancelled: that side of the book is full.`,
      };
    case RESULT_STATUS_CODE.refusedPostOnlyWouldMatch:
      return { status: "rejected", reason: "Refused: a post-only order would have matched." };
    case RESULT_STATUS_CODE.remainderCancelledFillCheck:
      return {
        status: filledAny ? "partiallyFilled" : "cancelled",
        reason: fillCheckReason(filledAny),
      };
    case RESULT_STATUS_CODE.refused:
      return {
        status: "rejected",
        reason: describeProgramError(result.code, market) ?? ORDER_REFUSED_REASON,
      };
    default:
      return { status: "rejected", reason: UNRECOGNISED_RESULT_REASON };
  }
}

/**
 * A cancel that cancelled something is `{ cancelled }`. One that cancelled
 * nothing says why: the order is gone (filled, expired or cancelled before),
 * or the program refused the cancel with a code of its own.
 */
export function cancelToResult(result: OrderResult & Partial<Timing>): CancelResult {
  const cancelled = Number(result.cancelled);
  if (cancelled > 0) return { cancelled };
  const refusedForAnotherReason =
    result.status === RESULT_STATUS_CODE.refused && result.code !== PROGRAM_ERROR.orderNotFound;
  return {
    cancelled,
    reason: refusedForAnotherReason
      ? (describeProgramError(result.code) ?? CANCEL_REFUSED_REASON)
      : NOTHING_TO_CANCEL_REASON,
  };
}

/**
 * Maps whatever `cancelOrder`/`cancelAll` (or `syncView`, same contract)
 * throws onto a `CancelResult` the caller can render without a raw error
 * reaching the UI: `OutcomeUnknown` becomes a pending result that resolves
 * once the rollup's own clock has passed the call's expiry; every slot
 * busy becomes an immediate, certain zero with a plain reason; a program
 * refusal that landed on chain becomes a zero with its sentence. Any other
 * error is the caller's to handle (typically a session problem `withSession`
 * already retries once).
 */
export function cancelErrorToResult(error: unknown, expiresAtMs: number): CancelResult | null {
  if (error instanceof OutcomeUnknown) {
    return {
      cancelled: 0,
      pending: {
        expiresAtMs,
        settled: error.settled
          .then((result): CancelResult =>
            result
              ? cancelToResult(result)
              : {
                  cancelled: 0,
                  reason: "Expired, not run. The venue never ran this cancel; try again.",
                },
          )
          .catch((): CancelResult => ({ cancelled: 0, reason: UNCONFIRMED_OUTCOME_REASON })),
      },
    };
  }
  if (isAllKeysBusy(error)) {
    return { cancelled: 0, reason: ALL_SLOTS_BUSY_REASON };
  }
  if (error instanceof TransactionFailed) {
    const reason =
      error.code === null
        ? CANCEL_REFUSED_REASON
        : (describeTransactionError(error.code, {}) ?? CANCEL_REFUSED_REASON);
    return { cancelled: 0, reason };
  }
  return null;
}

/** Same contract as `cancelErrorToResult`, for `transferBetweenBalances`. */
export function transferErrorToResult(error: unknown, expiresAtMs: number): TransferResult | null {
  if (error instanceof OutcomeUnknown) {
    return {
      kind: "pending",
      pending: {
        expiresAtMs,
        settled: error.settled
          .then((result): TransferResult =>
            result
              ? { kind: "ok" }
              : {
                  kind: "error",
                  message: "Expired, not run. The venue never ran this transfer; try again.",
                },
          )
          .catch((): TransferResult => ({ kind: "error", message: UNCONFIRMED_OUTCOME_REASON })),
      },
    };
  }
  if (isAllKeysBusy(error)) {
    return { kind: "error", message: ALL_SLOTS_BUSY_REASON };
  }
  return null;
}
