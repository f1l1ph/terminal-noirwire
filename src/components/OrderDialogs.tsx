"use client";

import { formatDecimal } from "@/lib/format";
import { marketDisplayName } from "@/lib/market-data/displayName";
import { limitSentAsIoc } from "@/lib/trading/orderType";
import { REAL_MONEY_STATEMENTS } from "@/lib/trading/realMoneyAck";
import { leverageLabel } from "@/lib/trading/ticketSizing";
import type { NewOrderInput } from "@/lib/trading/types";
import { sideWord } from "@/lib/trading/uiRules";
import { OrderSummary, type SummaryRow } from "@/components/OrderSummary";
import type { OrderDescriptor } from "@/components/WitnessRail";
import { Dialog } from "@/components/ui/Dialog";
import { btnDanger, btnGhost, btnPrimary, btnSafe } from "@/components/ui/styles";

/** Exactly what the confirm dialog showed and what will be signed, fixed when the dialog opened. */
export interface FrozenOrder {
  draft: NewOrderInput;
  descriptor: OrderDescriptor;
  markPrice: string;
  worstCost: string;
  leverage: number;
  /** The price field held a typed price, not the default that follows the mark. */
  priceTyped: boolean;
  /** The rows the dialog's summary shows, fixed with the order so they cannot drift from the reviewed cost. */
  summaryRows: SummaryRow[] | null;
}

/** Escape and a backdrop press both mean Back: the choice that never sends anything. */
export function RealMoneyDialog({
  onBack,
  onAccept,
}: {
  onBack: () => void;
  onAccept: () => void;
}) {
  return (
    <Dialog name={{ label: "Real money" }} onDismiss={onBack}>
      <p className="text-ink-strong text-[14px] font-medium">This is real money</p>
      <ul className="text-dim mt-2 flex list-disc flex-col gap-1 pl-4 text-[12px]">
        {REAL_MONEY_STATEMENTS.map((statement) => (
          <li key={statement}>{statement}</li>
        ))}
      </ul>
      <div className="mt-4 flex gap-3">
        <button
          type="button"
          data-initial-focus
          className={`${btnGhost} h-11 flex-1`}
          onClick={onBack}
        >
          Back
        </button>
        <button type="button" className={`${btnPrimary} h-11 flex-1`} onClick={onAccept}>
          I understand
        </button>
      </div>
    </Dialog>
  );
}

/** Escape and a backdrop press both mean Back, as for the real-money dialog. */
export function ConfirmOrderDialog({
  order,
  isPerp,
  makersListed,
  sizeDecimals,
  priceDecimals,
  baseName,
  quoteUnit,
  reviewInvalid,
  note = null,
  blocker,
  canSubmit,
  submitLabel,
  onBack,
  onConfirm,
}: {
  order: FrozenOrder;
  isPerp: boolean;
  makersListed: boolean;
  sizeDecimals: number;
  priceDecimals: number;
  baseName: string;
  quoteUnit: string;
  /** Why the review no longer stands; swaps the confirm button for "Close and review again". */
  reviewInvalid: string | null;
  /** A plain line above any error: what changed since the owner last looked. */
  note?: string | null;
  /** Why the order cannot be placed right now, shown when the review itself still stands. */
  blocker: string | null;
  canSubmit: boolean;
  submitLabel: string;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const { draft } = order;
  const error = reviewInvalid ?? blocker;
  return (
    <Dialog name={{ label: "Confirm order" }} onDismiss={onBack}>
      <p className="text-ink-strong text-[14px] font-medium">
        {marketDisplayName(draft.market)} ·{" "}
        {draft.type === "market"
          ? "Market"
          : draft.reduceOnly || limitSentAsIoc(draft.type, makersListed, draft.reduceOnly)
            ? "Limit (fills now or cancels)"
            : "Limit"}{" "}
        · {sideWord(isPerp, draft.side)} {formatDecimal(draft.size, sizeDecimals)} {baseName}
        {isPerp && !draft.reduceOnly ? ` · ${leverageLabel(order.leverage)}` : ""}
      </p>
      {draft.type === "limit" && (
        <p className="text-faint mt-1 text-[12px]">
          Limit price {formatDecimal(draft.price, priceDecimals)} {quoteUnit}
        </p>
      )}
      <p className="text-faint mt-1 mb-3 text-[12px]">Worst case: {order.worstCost}</p>
      <OrderSummary rows={order.summaryRows} />
      {note && (
        <p role="status" className="text-warning mt-3 text-[12px]">
          {note}
        </p>
      )}
      {error && (
        <p role="alert" className="text-danger mt-3 text-[12px]">
          {error}
        </p>
      )}
      <div className="mt-4 flex gap-3">
        <button
          type="button"
          data-initial-focus
          className={`${btnGhost} h-11 flex-1`}
          onClick={onBack}
        >
          Back
        </button>
        {reviewInvalid ? (
          <button type="button" className={`${btnPrimary} h-11 flex-1`} onClick={onBack}>
            Close and review again
          </button>
        ) : (
          <button
            type="button"
            className={`${draft.side === "buy" ? btnSafe : btnDanger} h-11 flex-1`}
            disabled={!canSubmit}
            onClick={onConfirm}
          >
            {submitLabel}
          </button>
        )}
      </div>
    </Dialog>
  );
}
