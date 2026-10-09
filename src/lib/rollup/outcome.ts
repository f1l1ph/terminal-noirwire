import type { CancelResult, OrderStatus, PlaceOrderResult } from "../trading/types";
import type { MarketUnits } from "./units";
import { lotsToSize } from "./units";
import {
  OrderInvalid,
  RESULT_STATUS_CODE,
  TransactionFailed,
  type OrderResult,
  type Placed,
  type Timing,
} from "./sdk";

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
 * timestamp than wrapping the whole call.
 */
export function placedToResult(
  placed: Placed,
  units: MarketUnits,
  sizeDecimals: number,
): PlaceOrderResult {
  if (placed.outcome === "expired") {
    return {
      orderId: "",
      tag: "",
      status: "rejected",
      filledSize: "0",
      remainingSize: "0",
      reason:
        "This order expired before the venue confirmed it. It was not placed; its order key is still usable.",
      sentAtMs: placed.sentAt,
    };
  }
  const { result } = placed;
  const filledSize = lotsToSize(units, result.filled, sizeDecimals);
  const restedSize = lotsToSize(units, result.rested, sizeDecimals);
  const cancelledSize = lotsToSize(units, result.cancelled, sizeDecimals);
  const orderId = result.rested > 0n || result.orderSeq > 0n ? result.orderSeq.toString() : "";

  const { status, reason } = describeStatus(result, filledSize);
  return {
    orderId,
    tag: "",
    status,
    filledSize,
    remainingSize: result.rested > 0n ? restedSize : cancelledSize,
    reason,
    sentAtMs: placed.sentAt,
    resultAtMs: placed.resultAt,
  };
}

/**
 * `placeOrder` throws instead of returning an outcome for these two cases
 * (0.3.0): `OrderInvalid` when the order would be refused on the market's
 * own public settings alone, checked before anything is signed;
 * `TransactionFailed` when the transaction landed on chain and the program
 * refused it. Both are mapped to the witness rail's ordinary rejected state
 * with a plain sentence, exactly like a book-dependent refusal, rather than
 * surfacing as a raw thrown error.
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

/** `null` means the instruction expired before its result showed; the UI treats that as "unknown, try again." */
export function cancelToResult(result: (OrderResult & Partial<Timing>) | null): CancelResult {
  return { cancelled: result ? Number(result.cancelled) : 0 };
}
