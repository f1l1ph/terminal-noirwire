import { formatClockTime, formatDuration, formatMoney, formatSize } from "@/lib/format";
import type { OpenOrder, OwnFill } from "@/lib/trading/types";
import { btnGhost, panel } from "@/components/ui/styles";

export type RailStepType =
  "submitted" | "confirmed" | "resting" | "partiallyFilled" | "filled" | "rejected";

export interface RailStep {
  type: RailStepType;
  at: number;
  detail?: string;
}

const STEP_LABELS: Record<RailStepType, string> = {
  submitted: "Submitted",
  confirmed: "Confirmed",
  resting: "Resting",
  partiallyFilled: "Partially filled",
  filled: "Filled",
  rejected: "Rejected",
};

export function WitnessRail({
  steps,
  openOrder,
  fills,
  sizeDecimals,
  clientDurationMs,
  onCancel,
  cancelling,
}: {
  steps: RailStep[];
  openOrder: OpenOrder | null;
  fills: OwnFill[];
  sizeDecimals: number;
  clientDurationMs: number | null;
  onCancel: () => void;
  cancelling: boolean;
}) {
  if (steps.length === 0) {
    return (
      <div className={`${panel} p-4`}>
        <p className="text-faint text-[11px] tracking-wide uppercase">Witness rail</p>
        <p className="text-dim mt-3 text-[13px]">
          Your orders appear here. Public fills appear in the tape.
        </p>
      </div>
    );
  }

  return (
    <div className={`${panel} p-4`} aria-live="polite">
      <p className="text-faint text-[11px] tracking-wide uppercase">Witness rail</p>
      <ol className="mt-3 flex flex-col gap-2">
        {steps.map((step, index) => (
          <li
            key={`${step.type}-${index}`}
            className="rail-step-in flex items-baseline justify-between gap-3 text-[13px]"
          >
            <span className={step.type === "rejected" ? "text-danger" : "text-ink"}>
              {STEP_LABELS[step.type]}
            </span>
            <span className="tnum text-faint text-[12px]">
              {formatClockTime(new Date(step.at))}
            </span>
          </li>
        ))}
      </ol>
      {steps.at(-1)?.type === "rejected" && steps.at(-1)?.detail && (
        <p className="text-danger mt-2 text-[12px]">{steps.at(-1)?.detail}</p>
      )}
      {clientDurationMs !== null && (
        <p className="tnum text-faint mt-3 text-[12px]">
          Click to confirmation: {formatDuration(clientDurationMs)} · this device
        </p>
      )}
      {openOrder && (
        <div className="border-line-subtle mt-3 border-t pt-3 text-[13px]">
          <p className="tnum text-ink">
            {formatSize(openOrder.quantity, sizeDecimals)} at{" "}
            {openOrder.limitPrice ? openOrder.limitPrice : "market"} · remaining{" "}
            {formatSize(
              (Number(openOrder.quantity) - Number(openOrder.filledQuantity)).toString(),
              sizeDecimals,
            )}
          </p>
          <p className="text-faint mt-1 text-[12px]">Order {openOrder.orderId}</p>
          <button
            type="button"
            className={`${btnGhost} mt-2 h-9 px-3 text-[12px]`}
            disabled={cancelling}
            onClick={onCancel}
          >
            {cancelling ? "Cancelling…" : "Cancel order"}
          </button>
        </div>
      )}
      {fills.length > 0 && (
        <div className="border-line-subtle mt-3 border-t pt-3">
          <p className="text-faint text-[11px] tracking-wide uppercase">Fills</p>
          <ul className="mt-2 flex flex-col gap-1">
            {fills.map((fill) => (
              <li key={fill.fillId} className="tnum flex justify-between text-[12px]">
                <span className="text-ink">
                  {formatSize(fill.quantity, sizeDecimals)} @ {fill.price}
                </span>
                <span className="text-faint">fee {formatMoney(fill.fee)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
