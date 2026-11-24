import type { TriggerChainState, TriggerResult, TriggerStatuses } from "../trading/types";
import { describeProgramError, describeTransactionError, PROGRAM_ERROR } from "./refusals";
import {
  ALL_KEYS_BUSY_MESSAGE,
  OutcomeUnknown,
  RESULT_STATUS_CODE,
  TransactionFailed,
  type OrderResult,
  type TriggerStatus,
  type TriggerState,
} from "./sdk";
import { UNCONFIRMED_OUTCOME_REASON } from "./outcome";

export const TRIGGERS_NOT_LIVE_REASON =
  "Take profit and stop loss are not available yet: the exchange is still being upgraded. Nothing was changed.";
export const TRIGGERS_PERPS_ONLY_REASON =
  "Take profit and stop loss work on perpetual markets only. Nothing was changed.";

const GENERIC_REFUSAL =
  "The exchange did not accept this. Nothing was changed. Try again in a moment.";
const ALL_SLOTS_BUSY_REASON =
  "All four of this wallet's order-key slots are busy right now. Wait for one to free up, then try again. Nothing was changed.";
const STALE_PRICE_REASON =
  "The market's price is too old to set a trigger against. Wait for a fresh price and try again. Nothing was changed.";
const EXPIRED_NOT_RUN_REASON =
  "Expired, not run. The exchange never ran this request; try again. Nothing was changed.";

/** The sentence for a refusal by its number in the program's list, worded for a trigger rather than an order. */
export function triggerRefusalReason(code: number | null): string {
  if (code === null) return GENERIC_REFUSAL;
  if (code === PROGRAM_ERROR.stalePrice) return STALE_PRICE_REASON;
  return describeProgramError(code) ?? GENERIC_REFUSAL;
}

/** A set or a removal that the exchange ran is `ok`; one it refused carries its sentence. Removing nothing is not a refusal. */
export function triggerToResult(result: OrderResult): TriggerResult {
  if (result.status === RESULT_STATUS_CODE.refused) {
    return { kind: "refused", reason: triggerRefusalReason(result.code) };
  }
  return { kind: "ok" };
}

/**
 * Maps whatever `setTrigger` or `cancelTrigger` throws onto a result the
 * caller can render: a call whose outcome is not yet certain becomes a pending
 * result, every slot busy and a failed transaction become a refusal with a
 * plain reason. Anything else is the caller's to handle.
 */
export function triggerErrorToResult(error: unknown, expiresAtMs: number): TriggerResult | null {
  if (error instanceof OutcomeUnknown) {
    return {
      kind: "pending",
      pending: {
        expiresAtMs,
        settled: error.settled
          .then((result): TriggerResult =>
            result ? triggerToResult(result) : { kind: "refused", reason: EXPIRED_NOT_RUN_REASON },
          )
          .catch((): TriggerResult => ({ kind: "refused", reason: UNCONFIRMED_OUTCOME_REASON })),
      },
    };
  }
  if (error instanceof Error && error.message === ALL_KEYS_BUSY_MESSAGE) {
    return { kind: "refused", reason: ALL_SLOTS_BUSY_REASON };
  }
  if (error instanceof TransactionFailed) {
    const reason =
      error.code === null
        ? GENERIC_REFUSAL
        : (describeTransactionError(error.code, {}) ?? GENERIC_REFUSAL);
    return { kind: "refused", reason };
  }
  return null;
}

function chainStateOf(state: TriggerState): TriggerChainState {
  if (state.state === "armed" || state.state === "gone") return { state: state.state };
  return {
    state: state.state,
    ...(state.nextAttempt !== undefined && state.nextAttempt > 0n
      ? { nextAttemptMs: Number(state.nextAttempt) * 1000 }
      : {}),
  };
}

/** The exchange's report on one market's triggers, with the time this device read it. */
export function triggerStatusesFrom(status: TriggerStatus, readAtMs: number): TriggerStatuses {
  return {
    takeProfit: chainStateOf(status.takeProfit),
    stopLoss: chainStateOf(status.stopLoss),
    readAtMs,
  };
}
