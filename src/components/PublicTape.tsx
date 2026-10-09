import { formatClockTime, formatDecimal } from "@/lib/format";
import type { PublicFill } from "@/lib/market-data/types";
import { panel, sectionLabel } from "@/components/ui/styles";

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
}: {
  fills: PublicFill[];
  priceDecimals: number;
  sizeDecimals: number;
  ownSequences: ReadonlySet<number>;
}) {
  return (
    <div className={`${panel} flex min-h-0 flex-1 flex-col`}>
      <p className={`${sectionLabel} border-line-subtle shrink-0 border-b px-3 py-1.5`}>
        Public tape
      </p>
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
                className={`tnum flex items-center justify-between gap-3 px-3 py-1 text-[12px] ${
                  mine ? "bg-elevated" : ""
                }`}
              >
                <span className="text-faint">{formatClockTime(new Date(fill.timestampMs))}</span>
                <span className={fill.takerSide === "buy" ? "text-safe" : "text-danger"}>
                  {fill.takerSide === "buy" ? "buy" : "sell"}
                </span>
                <span className="text-ink">{formatDecimal(fill.price, priceDecimals)}</span>
                <span className="text-dim">{formatDecimal(fill.size, sizeDecimals)}</span>
                {mine && (
                  <span className="text-ink-strong border-line-strong rounded-full border px-1.5 py-0.5 text-[10px]">
                    yours
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
