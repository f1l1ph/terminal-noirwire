import type { PublicFill } from "../market-data/types";
import type { OwnFillRecord } from "../trading/tags";
import type { Side } from "../trading/types";
import { bytesToHex } from "../wallet/index";
import { fillReceipt } from "./sdk";

const opposite = (side: Side): Side => (side === "buy" ? "sell" : "buy");

/**
 * Reads an 8-byte receipt as the big-endian u64 decimal string sim-noirwire
 * puts in a rollup-mode tape row's `takerTag` / `makerTag` fields
 * (`src/rollup/rollup-venue.ts`'s `tagOf`, read from that repository: `const
 * tagOf = (receipt) => Buffer.from(receipt).readBigUInt64BE(0)`, then
 * `tagString` on the route). The field names are the dev-mode wire shape's;
 * what they carry in rollup mode is a per-fill receipt, never a reusable tag.
 */
function receiptTag(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes.slice(0, 8)) value = (value << 8n) | BigInt(byte);
  return value.toString();
}

/**
 * Rollup-mode own-fill recognition (DESIGN.md section 3; RULES.md section
 * 10). There is no venue-assigned order tag to remember here, only the
 * 16-byte secret this browser chose for each of its own orders. For every
 * tape fill, recompute the maker and taker receipt from each known secret at
 * that fill's own sequence number and compare against the fill's receipt
 * fields - no client tag is ever sent or expected on the public tape, so an
 * observer who only watches the tape cannot link these fills to one trader
 * (RULES.md section 10's own claim).
 */
export function deriveRollupOwnFills(
  fills: readonly PublicFill[],
  secrets: readonly Uint8Array[],
): OwnFillRecord[] {
  const records: OwnFillRecord[] = [];
  for (const fill of fills) {
    const fillSeq = BigInt(fill.sequence);
    for (const secret of secrets) {
      const asTaker = receiptTag(fillReceipt(secret, fillSeq, "taker")) === fill.takerTag;
      const asMaker =
        !asTaker && receiptTag(fillReceipt(secret, fillSeq, "maker")) === fill.makerTag;
      if (!asTaker && !asMaker) continue;
      records.push({
        sequence: fill.sequence,
        market: fill.market,
        side: asTaker ? fill.takerSide : opposite(fill.takerSide),
        price: fill.price,
        size: fill.size,
        timestampMs: fill.timestampMs,
        role: asTaker ? "taker" : "maker",
        // Narrows the witness rail to one tracked order's fills in the UI;
        // this is the secret's own hex, held only on this device, never sent.
        tag: bytesToHex(secret),
      });
      break;
    }
  }
  return records;
}
