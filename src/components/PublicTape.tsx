import { formatClockTime, formatSize, formatPrice } from "@/lib/format";
import { isOwnTag } from "@/lib/trading/tags";
import type { PublicFill } from "@/lib/market-data/types";
import { panel } from "@/components/ui/styles";

export function PublicTape({
  fills,
  priceDecimals,
  sizeDecimals,
  ownTags,
}: {
  fills: PublicFill[];
  priceDecimals: number;
  sizeDecimals: number;
  ownTags: ReadonlySet<string>;
}) {
  return (
    <div className={`${panel} flex flex-col`}>
      <p className="text-faint border-line-subtle border-b px-4 py-2 text-[11px] tracking-wide uppercase">
        Public tape
      </p>
      {fills.length === 0 ? (
        <p className="text-faint p-4 text-[13px]">No fills yet.</p>
      ) : (
        <ul
          className="max-h-[220px] overflow-y-auto"
          aria-label="Public fills, no account identity"
        >
          {fills.map((fill, index) => {
            const mine = isOwnTag(fill.tag, ownTags);
            return (
              <li
                key={`${fill.sequence}-${index}`}
                className={`tnum flex items-center justify-between gap-3 px-4 py-1.5 text-[13px] ${
                  mine ? "bg-elevated" : ""
                }`}
              >
                <span className="text-faint">{formatClockTime(new Date(fill.time))}</span>
                <span className={fill.takerSide === "buy" ? "text-safe" : "text-danger"}>
                  {fill.takerSide === "buy" ? "buy" : "sell"}
                </span>
                <span className="text-ink">{formatPrice(fill.price, priceDecimals)}</span>
                <span className="text-dim">{formatSize(fill.size, sizeDecimals)}</span>
                {mine && (
                  <span className="text-ink-strong border-line-strong rounded-full border px-2 py-0.5 text-[10px]">
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
