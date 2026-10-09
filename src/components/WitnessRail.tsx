import { formatClockTime, formatDecimal, formatDuration, isLocalNetwork } from "@/lib/format";
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
  /** This device's own clock (Date.now()), set once when the step is first observed - never a venue-reported event time. See `describeVenueTime` for that, shown separately. */
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

export interface RecentMarketActivity {
  market: string;
  summary: string;
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

function RecentActivity({
  markets,
  onSelect,
}: {
  markets: RecentMarketActivity[];
  onSelect: (market: string) => void;
}) {
  if (markets.length === 0) return null;
  return (
    <div className="mb-1.5 flex flex-wrap gap-1" aria-label="Recent activity">
      <span className="text-faint self-center text-[10px] uppercase">Recent:</span>
      {markets.map((item) => (
        <button
          key={item.market}
          type="button"
          className={`${btnGhost} h-6 px-2 text-[10px]`}
          onClick={() => onSelect(item.market)}
        >
          {item.market} · {item.summary}
        </button>
      ))}
    </div>
  );
}

export function WitnessRail({
  market,
  order,
  steps,
  openOrder,
  ownFills,
  clientDurationMs,
  network,
  recentMarkets,
  onSelectMarket,
  hasAccountHistory,
  onViewFills,
  onCancelAll,
  onCancelOrder,
  cancelling,
  cancelPending,
  cancelMessage,
  now,
}: {
  /** The currently selected market - used only for the empty-state copy, never for the order description (that comes from `order`). */
  market: string;
  order: OrderDescriptor | null;
  steps: RailStep[];
  openOrder: OpenOrder | null;
  ownFills: OwnFillRecord[];
  clientDurationMs: number | null;
  /** The deployment's own network field; drives the "local" qualifier per the second design review (never show a measured number without naming the network it came from). */
  network: string;
  /** Other markets this session has an order history for, most recent first - lets switching markets not erase what happened elsewhere. */
  recentMarkets: RecentMarketActivity[];
  onSelectMarket: (market: string) => void;
  /** True when the account shows positions/fills this session's own order history does not explain (a reload, most commonly) - drives the "this session only" copy instead of a plain empty prompt. */
  hasAccountHistory: boolean;
  onViewFills: () => void;
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
  const networkWord = isLocalNetwork(network) ? "local" : network.toLowerCase();

  if (!order || steps.length === 0) {
    return (
      <div className={`${panel} flex min-h-0 flex-1 flex-col p-3`}>
        <p className={sectionLabel}>Witness rail</p>
        <RecentActivity markets={recentMarkets} onSelect={onSelectMarket} />
        {hasAccountHistory ? (
          <>
            <p className="text-dim mt-1 text-[13px]">
              This session only. No order placed in {market} yet this browser session - earlier
              activity is not restored after a reload.
            </p>
            <button
              type="button"
              className="text-ink mt-1.5 self-start text-[12px] underline"
              onClick={onViewFills}
            >
              View fills
            </button>
          </>
        ) : (
          <p className="text-dim mt-2 text-[13px]">
            Your orders appear here. Public fills appear in the tape.
          </p>
        )}
      </div>
    );
  }

  const lastStep = steps.at(-1);

  return (
    <div className={`${panel} flex min-h-0 flex-1 flex-col p-3`} aria-live="polite">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <p className={sectionLabel}>Witness rail</p>
        <RecentActivity markets={recentMarkets} onSelect={onSelectMarket} />
        <p className="text-ink mt-1 text-[13px] font-medium">{describeOrder(order)}</p>

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
            This order · {networkWord} click to result {formatDuration(clientDurationMs)}
          </p>
        )}

        {openOrder && (
          <div className="border-line-subtle mt-2 border-t pt-2 text-[12px]">
            <p className="tnum text-ink">
              Remaining {formatDecimal(openOrder.remainingSize, order.sizeDecimals)}{" "}
              {order.baseUnit} of {formatDecimal(openOrder.size, order.sizeDecimals)}
            </p>
            <p className="text-faint mt-0.5">Order {openOrder.orderId}</p>
          </div>
        )}

        {ownFills.length > 0 && (
          <div className="border-line-subtle mt-2 border-t pt-2">
            <p className={sectionLabel}>Fills</p>
            <ul className="mt-1 flex flex-col gap-1">
              {ownFills.map((fill) => (
                <li key={fill.sequence} className="tnum flex flex-col text-[12px]">
                  <span className="flex justify-between">
                    <span className="text-ink">
                      {formatDecimal(fill.size, order.sizeDecimals)} {order.baseUnit} @{" "}
                      {formatDecimal(fill.price, order.priceDecimals)}
                    </span>
                    <span className="text-faint">{fill.role}</span>
                  </span>
                  <span className="text-faint text-[10px]">
                    venue reported {formatClockTime(new Date(fill.timestampMs))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {openOrder && (
        <div className="border-line-subtle shrink-0 border-t pt-2 text-[12px]">
          <button
            type="button"
            className={`${btnGhost} h-8 w-full px-3 text-[12px]`}
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
    </div>
  );
}
