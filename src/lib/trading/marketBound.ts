import { fromFixedPoint, toFixedPoint } from "./decimal";
import type { Side } from "./types";

/** How far past the mark a market order's worst price sits by default. */
const DEFAULT_SLIPPAGE_BPS = 100;
const BPS = 10_000n;

function floorToTick(value: bigint, tick: bigint): bigint {
  return tick > 0n ? value - (value % tick) : value;
}

function ceilToTick(value: bigint, tick: bigint): bigint {
  const floored = floorToTick(value, tick);
  return floored === value ? value : floored + tick;
}

/**
 * The worst price a market order may fill at: a set distance past the mark,
 * rounded to the tick away from the mark, and never outside the crossing band
 * the program enforces (a bid at most `bandBps` above the mark, an ask at most
 * that far below it). A close (`reduceOnly`) reaches the outermost tick still
 * inside the band, rounded toward the mark so it stays inside, so it can hit
 * any quote the program allows; any other order takes 1%. The mark must be
 * the freshest one: a bound at the band's edge is only inside the band for the
 * mark it was built from. `bandBps` is absent until the market account has
 * been read.
 */
export function marketOrderBound(params: {
  markPrice: string;
  side: Side;
  tick: string;
  priceDecimals: number;
  bandBps?: number;
  reduceOnly?: boolean;
}): string {
  const mark = toFixedPoint(params.markPrice);
  const tick = toFixedPoint(params.tick);
  const band = params.bandBps === undefined ? null : BigInt(params.bandBps);
  const distance =
    band === null
      ? BigInt(DEFAULT_SLIPPAGE_BPS)
      : params.reduceOnly
        ? band
        : band < BigInt(DEFAULT_SLIPPAGE_BPS)
          ? band
          : BigInt(DEFAULT_SLIPPAGE_BPS);
  let bound: bigint;
  if (params.side === "buy") {
    bound = ceilToTick((mark * (BPS + distance)) / BPS, tick);
    if (band !== null) {
      const ceiling = floorToTick((mark * (BPS + band)) / BPS, tick);
      if (bound > ceiling) bound = ceiling;
    }
  } else {
    bound = floorToTick((mark * (BPS - distance)) / BPS, tick);
    if (band !== null) {
      const floor = ceilToTick((mark * (BPS - band)) / BPS, tick);
      if (bound < floor) bound = floor;
    }
  }
  return fromFixedPoint(bound, params.priceDecimals);
}
