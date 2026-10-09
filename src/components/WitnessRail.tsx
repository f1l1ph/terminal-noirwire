import { formatClockTime, formatDecimal, formatDuration, formatRelativeAge } from "@/lib/format";
import type { OwnFillRecord } from "@/lib/trading/tags";
import type { OpenOrder, Side } from "@/lib/trading/types";
import { btnGhost, panel, sectionLabel } from "@/components/ui/styles";

export type RailStepType =
  | "submitted"
  | "confirmed"
  | "unknown"
  | "resting"
  | "partiallyFilled"
  | "filled"
  | "cancelled"
  | "rejected";

export interface RailStep {
  type: RailStepType;
  at: number;
  detail?: string;
}

export interface OrderDescriptor {
  market: string;
  side: Side;
  type: "market" | "limit";
  price: string;
  size: string;
  baseUnit: string;
  quoteUnit: string;
  priceDecimals: number;
  sizeDecimals: number;
}

const STEP_LABELS: Record<RailStepType, string> = {
  submitted: "Submitted",
  confirmed: "Confirmed",
  unknown: "Checking with the venue",
  resting: "Resting",
  partiallyFilled: "Partially filled",
  filled: "Filled",
  cancelled: "Cancelled",
  rejected: "Rejected",
};

function describeOrder(order: OrderDescriptor): string {
  const direction = order.side === "buy" ? "Long" : "Short";
  const size = formatDecimal(order.size, order.sizeDecimals);
  const typeLabel =
    order.type === "market"
      ? `Market, max ${order.side === "buy" ? "buy" : "sell"} ${formatDecimal(order.price, order.priceDecimals)} ${order.quoteUnit}`
      : `Limit ${formatDecimal(order.price, order.priceDecimals)} ${order.quoteUnit}`;
  return `${direction} ${size} ${order.baseUnit} · ${typeLabel}`;
}

export function WitnessRail({
  order,
  steps,
  openOrder,
  ownFills,
  clientDurationMs,
  onCancelAll,
  onCancelOrder,
  cancelling,
  cancelPending,
  cancelMessage,
  now,
}: {
  order: OrderDescriptor | null;
  steps: RailStep[];
  openOrder: OpenOrder | null;
  ownFills: OwnFillRecord[];
  clientDurationMs: number | null;
  onCancelAll: () => void;
  /** Present only when the trading client supports a per-order cancel (the real program does; sim-noirwire's dev routes do not). */
  onCancelOrder: (() => void) | null;
  cancelling: boolean;
  /** Set while a cancel's own outcome is not yet certain (rollup mode): shows a countdown next to the cancel button instead of resending it. */
  cancelPending?: { expiresAtMs: number } | null;
  /** A plain reason the last cancel attempt could not be sent at all (e.g. every order-key slot busy), shown once and cleared on the next attempt. */
  cancelMessage?: string | null;
  now: number;
}) {
  if (!order || steps.length === 0) {
    return (
      <div className={`${panel} flex min-h-0 flex-1 flex-col p-3`}>
        <p className={sectionLabel}>Witness rail</p>
        <p className="text-dim mt-2 text-[13px]">
          Your orders appear here. Public fills appear in the tape.
        </p>
      </div>
    );
  }

  const lastStep = steps.at(-1);

  return (
    <div className={`${panel} flex min-h-0 flex-1 flex-col overflow-y-auto p-3`} aria-live="polite">
      <p className={sectionLabel}>Witness rail</p>
      <p className="text-ink mt-2 text-[13px] font-medium">{describeOrder(order)}</p>

      <ol className="mt-2 flex flex-col gap-1.5">
        {steps.map((step, index) => (
          <li
            key={`${step.type}-${index}`}
            className="rail-step-in flex items-baseline justify-between gap-3 text-[12px]"
          >
            <span className={step.type === "rejected" ? "text-danger" : "text-ink"}>
              {STEP_LABELS[step.type]}
            </span>
            <span className="tnum text-faint">{formatClockTime(new Date(step.at))}</span>
          </li>
        ))}
      </ol>

      {lastStep?.type === "rejected" && lastStep.detail && (
        <p className="text-danger mt-1 text-[12px]">{lastStep.detail}</p>
      )}
      {(lastStep?.type === "cancelled" || lastStep?.type === "unknown") && lastStep.detail && (
        <p className="text-faint mt-1 text-[12px]">{lastStep.detail}</p>
      )}

      {clientDurationMs !== null && (
        <p className="tnum text-faint mt-2 text-[12px]">
          This device, click to venue response: {formatDuration(clientDurationMs)}
        </p>
      )}

      {openOrder && (
        <div className="border-line-subtle mt-2 border-t pt-2 text-[12px]">
          <p className="tnum text-ink">
            Remaining {formatDecimal(openOrder.remainingSize, order.sizeDecimals)} {order.baseUnit}{" "}
            of {formatDecimal(openOrder.size, order.sizeDecimals)} {"·"} age{" "}
            {formatRelativeAge(
              Math.max(now - (steps.find((s) => s.type === "resting")?.at ?? now), 0),
            )}
          </p>
          <p className="text-faint mt-0.5">Order {openOrder.orderId}</p>
          <button
            type="button"
            className={`${btnGhost} mt-2 h-8 w-full px-3 text-[12px]`}
            disabled={cancelling}
            onClick={onCancelOrder ?? onCancelAll}
          >
            {cancelling
              ? "Cancelling…"
              : onCancelOrder
                ? `Cancel order ${openOrder.orderId}`
                : `Cancel all ${order.market} orders`}
          </button>
          {cancelPending && (
            <p className="text-faint mt-1 text-[12px]">
              Checking with the venue. Do not resend yet. About{" "}
              {Math.max(0, Math.ceil((cancelPending.expiresAtMs - now) / 1000))}s.
            </p>
          )}
          {!cancelPending && cancelMessage && (
            <p role="alert" className="text-danger mt-1 text-[12px]">
              {cancelMessage}
            </p>
          )}
        </div>
      )}

      {ownFills.length > 0 && (
        <div className="border-line-subtle mt-2 border-t pt-2">
          <p className={sectionLabel}>Fills</p>
          <ul className="mt-1 flex flex-col gap-1">
            {ownFills.map((fill) => (
              <li key={fill.sequence} className="tnum flex justify-between text-[12px]">
                <span className="text-ink">
                  {formatDecimal(fill.size, order.sizeDecimals)} {order.baseUnit} @{" "}
                  {formatDecimal(fill.price, order.priceDecimals)}
                </span>
                <span className="text-faint">{fill.role}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
