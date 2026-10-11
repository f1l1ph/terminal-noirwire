import { formatClockTime, formatDecimal } from "@/lib/format";
import type { PublicFill } from "@/lib/market-data/types";
import { sectionLabel } from "@/components/ui/styles";

const ROW_COLUMNS = "grid-cols-[1fr_44px_minmax(0,1fr)_minmax(0,1fr)_auto]";

/**
 * Which fills are this trader's own, as the fill sequence numbers already
 * computed by `deriveOwnFills` (dev mode's tag) or `deriveRollupOwnFills`
 * (rollup mode's receipt) - a sequence number is mode-agnostic, unlike the
 * tag/receipt fields themselves, so this component never needs to know
 * which mode it is in.
 */
export function PublicTape({
  fills,
  priceDecimals,
  sizeDecimals,
  ownSequences,
  bordered = true,
}: {
  fills: PublicFill[];
  priceDecimals: number;
  sizeDecimals: number;
  ownSequences: ReadonlySet<number>;
  /** False inside the desktop Public tape panel frame, which already shows the "Public tape" name. True (default) on phone, where this renders standalone. */
  bordered?: boolean;
}) {
  return (
    <div
      className={`flex min-h-0 flex-1 flex-col ${bordered ? "bg-surface border-line-subtle rounded-panel border" : ""}`}
    >
      {bordered && (
        <p className={`${sectionLabel} border-line-subtle shrink-0 border-b px-3 py-1.5`}>
          Public tape
        </p>
      )}
      <div
        className={`text-faint border-line-subtle grid shrink-0 border-b px-3 py-1 text-[11px] tracking-wide uppercase ${ROW_COLUMNS}`}
      >
        <span>Time</span>
        <span>Side</span>
        <span className="text-right">Price</span>
        <span className="text-right">Size</span>
        <span />
      </div>
      {fills.length === 0 ? (
        <p className="text-faint p-3 text-[13px]">No fills yet.</p>
      ) : (
        <ul
          className="min-h-0 flex-1 overflow-y-auto"
          aria-label="Public fills, no account identity"
        >
          {fills.map((fill, index) => {
            const mine = ownSequences.has(fill.sequence);
            return (
              <li
                key={`${fill.sequence}-${index}`}
                className={`tnum grid items-center gap-2 px-3 py-1 text-[12px] ${ROW_COLUMNS} ${
                  mine ? "bg-elevated" : ""
                }`}
              >
                <span className="text-faint">{formatClockTime(new Date(fill.timestampMs))}</span>
                <span className={fill.takerSide === "buy" ? "text-safe" : "text-danger"}>
                  {fill.takerSide === "buy" ? "buy" : "sell"}
                </span>
                <span className="text-ink text-right">
                  {formatDecimal(fill.price, priceDecimals)}
                </span>
                <span className="text-dim text-right">
                  {formatDecimal(fill.size, sizeDecimals)}
                </span>
                {mine ? (
                  <span className="text-ink-strong border-line-strong rounded-full border px-1.5 py-0.5 text-[10px]">
                    yours
                  </span>
                ) : (
                  <span />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
