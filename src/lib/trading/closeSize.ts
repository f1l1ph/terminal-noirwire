function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * The size, in lots, to send for a reduce-only order. The program checks the
 * minimum size and value on the size typed, before it caps a reduce-only order
 * to the position, so a close of a small position would be refused though it
 * is the whole position. A full close therefore asks for at least the lots the
 * minimums need; the program trims it to the position. Any other order keeps
 * its size.
 */
export function reduceOnlyLots(params: {
  requested: bigint;
  /** The position's size in lots, either sign; zero when there is none or it is not known. */
  position: bigint;
  /** The order's price in quote atoms per lot. */
  price: bigint;
  minSize: bigint;
  /** The smallest order value in quote atoms. */
  minNotional: bigint;
}): bigint {
  const held = params.position < 0n ? -params.position : params.position;
  if (held === 0n || params.requested < held || params.price <= 0n) return params.requested;
  const forValue = ceilDiv(params.minNotional, params.price);
  const needed = forValue > params.minSize ? forValue : params.minSize;
  return needed > params.requested ? needed : params.requested;
}
