import type { PublicFill } from "../market-data/types";
import type { Side } from "./types";

/**
 * Recognising "yours" on the public tape, without a client-generated tag.
 *
 * sim-noirwire assigns a random 64-bit tag to every order when it is
 * placed (`PlaceOrderResult.tag`), and the same tag is echoed on that
 * order's own open-order row and on every public tape fill it takes part
 * in (`takerTag` / `makerTag`). This browser never sends or invents a tag:
 * it only remembers the tags the venue itself handed back for orders this
 * session placed, then checks whether a tape row's `takerTag` or
 * `makerTag` is one of them. A stable, client-chosen tag would let a public
 * observer link a trader's fills together; a venue-assigned, per-order tag
 * does not, and is exactly what the venue already publishes.
 */

export function isOwnFill(fill: PublicFill, ownTags: ReadonlySet<string>): boolean {
  return ownTags.has(fill.takerTag) || ownTags.has(fill.makerTag);
}

export interface OwnFillRecord {
  sequence: number;
  market: string;
  /** This trader's side in the fill: the taker's side if this trader was the taker, its opposite otherwise. */
  side: Side;
  price: string;
  size: string;
  timestampMs: number;
  role: "taker" | "maker";
  /** This trader's own tag that matched (whichever of takerTag/makerTag was in `ownTags`), so a caller can narrow to one order's fills. */
  tag: string;
}

const opposite = (side: Side): Side => (side === "buy" ? "sell" : "buy");

/**
 * Derives this trader's own fills from the public tape plus its known
 * tags: a fill where its tag is `takerTag` is a fill it took, one where
 * its tag is `makerTag` is a fill its resting order received. A fill can
 * only be found this way from the moment its tag became known (this
 * session's own orders); it is not a persisted history. See
 * docs/BUILD-NOTES.md, "Own fill history is session-only."
 */
export function deriveOwnFills(
  fills: readonly PublicFill[],
  ownTags: ReadonlySet<string>,
): OwnFillRecord[] {
  const records: OwnFillRecord[] = [];
  for (const fill of fills) {
    const asTaker = ownTags.has(fill.takerTag);
    const asMaker = ownTags.has(fill.makerTag);
    if (!asTaker && !asMaker) continue;
    records.push({
      sequence: fill.sequence,
      market: fill.market,
      side: asTaker ? fill.takerSide : opposite(fill.takerSide),
      price: fill.price,
      size: fill.size,
      timestampMs: fill.timestampMs,
      role: asTaker ? "taker" : "maker",
      tag: asTaker ? fill.takerTag : fill.makerTag,
    });
  }
  return records;
}
