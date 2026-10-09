import { formatDuration } from "../format";
import type { CancelResult, OrderStatus, PlaceOrderResult, TransferResult } from "../trading/types";
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

const ALL_SLOTS_BUSY_REASON =
  "All four of this wallet's order-key slots are busy right now. Wait for one to free up, then try again.";

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
 */
export function placedToResult(
  placed: Placed,
  units: MarketUnits,
  sizeDecimals: number,
  expiresAtMs?: number,
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
        settled: placed.settled.then((settled) =>
          settledToResult(settled, units, sizeDecimals, unknownAtMs),
        ),
      },
    };
  }
  return settledToResult(placed, units, sizeDecimals);
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
  unknownAtMs?: number,
): PlaceOrderResult {
  if (settled.outcome === "expired") {
    return {
      orderId: "",
      tag: "",
      status: "rejected",
      filledSize: "0",
      remainingSize: "0",
      reason: "Expired, not placed. The venue never ran this order; its order key is free again.",
      sentAtMs: settled.sentAt,
    };
  }
  const { result } = settled;
  const filledSize = lotsToSize(units, result.filled, sizeDecimals);
  const restedSize = lotsToSize(units, result.rested, sizeDecimals);
  const cancelledSize = lotsToSize(units, result.cancelled, sizeDecimals);
  const orderId = result.rested > 0n || result.orderSeq > 0n ? result.orderSeq.toString() : "";

  const { status, reason } = describeStatus(result, filledSize);
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
    sentAtMs: settled.sentAt,
    resultAtMs: settled.resultAt,
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
 * (`RollupTradingClient.placeOrder`) maps it to a pending result instead.
 */
export function thrownToResult(error: unknown): PlaceOrderResult | null {
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
        error.code !== null
          ? `Refused by the venue (program error ${error.code}). No fill occurred.`
          : "Refused by the venue. No fill occurred.",
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

function describeStatus(
  result: OrderResult,
  filledSize: string,
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
        reason: "The remainder did not match and was cancelled, not rested.",
      };
    case RESULT_STATUS_CODE.remainderCancelledStepLimit:
      return {
        status: filledAny ? "partiallyFilled" : "cancelled",
        reason: "The remainder was cancelled: this order crossed the venue's per-order fill limit.",
      };
    case RESULT_STATUS_CODE.remainderCancelledBookFull:
      return {
        status: filledAny ? "partiallyFilled" : "cancelled",
        reason: "The remainder was cancelled: that side of the book is full.",
      };
    case RESULT_STATUS_CODE.refusedPostOnlyWouldMatch:
      return { status: "rejected", reason: "Refused: a post-only order would have matched." };
    case RESULT_STATUS_CODE.remainderCancelledFillCheck:
      return {
        status: filledAny ? "partiallyFilled" : "cancelled",
        reason: "The remainder was cancelled: it failed the venue's margin check at this price.",
      };
    case RESULT_STATUS_CODE.refused:
      return {
        status: "rejected",
        reason: `Refused by the venue (code ${result.code}). No fill occurred.`,
      };
    default:
      return { status: "rejected", reason: `Unrecognised outcome (status ${result.status}).` };
  }
}

export function cancelToResult(result: OrderResult & Partial<Timing>): CancelResult {
  return { cancelled: Number(result.cancelled) };
}

/**
 * Maps whatever `cancelOrder`/`cancelAll` (or `syncView`, same contract)
 * throws onto a `CancelResult` the caller can render without a raw error
 * reaching the UI: `OutcomeUnknown` becomes a pending result that resolves
 * once the rollup's own clock has passed the call's expiry; every slot
 * busy becomes an immediate, certain zero with a plain reason. Any other
 * error is the caller's to handle (typically a session problem `withSession`
 * already retries once).
 */
export function cancelErrorToResult(error: unknown, expiresAtMs: number): CancelResult | null {
  if (error instanceof OutcomeUnknown) {
    return {
      cancelled: 0,
      pending: {
        expiresAtMs,
        settled: error.settled.then((result) =>
          result
            ? cancelToResult(result)
            : {
                cancelled: 0,
                reason: "Expired, not run. The venue never ran this cancel; try again.",
              },
        ),
      },
    };
  }
  if (isAllKeysBusy(error)) {
    return { cancelled: 0, reason: ALL_SLOTS_BUSY_REASON };
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
        settled: error.settled.then((result) =>
          result
            ? { kind: "ok" }
            : {
                kind: "error",
                message: "Expired, not run. The venue never ran this transfer; try again.",
              },
        ),
      },
    };
  }
  if (isAllKeysBusy(error)) {
    return { kind: "error", message: ALL_SLOTS_BUSY_REASON };
  }
  return null;
}
