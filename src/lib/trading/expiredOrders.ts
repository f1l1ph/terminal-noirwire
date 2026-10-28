import type { OpenOrder } from "./types";

/** A resting order's expiry is checked against a fresh reading of the rollup's clock at most this often, unless the estimate already points at one. */
export const EXPIRY_READ_EVERY_MS = 30_000;

/** The orders that will expire at some point, which are the ones whose expiry is worth checking. */
export function expiringOrders(orders: readonly OpenOrder[]): OpenOrder[] {
  return orders.filter(
    (order) => typeof order.expiresAtMs === "number" && Number.isFinite(order.expiresAtMs),
  );
}

/**
 * Whether to read the rollup's clock now: at once when the estimate says an
 * order has expired, otherwise only once the last reading is old enough. A
 * device clock that went backward makes the last reading look to be in the
 * future, which counts as old.
 */
export function shouldReadRollupClock(params: {
  estimateFlagsExpired: boolean;
  lastReadMs: number;
  nowMs: number;
}): boolean {
  if (params.estimateFlagsExpired) return true;
  const since = params.nowMs - params.lastReadMs;
  return since < 0 || since >= EXPIRY_READ_EVERY_MS;
}

/**
 * The orders whose own expiry the rollup's clock has passed, as the program
 * judges it: strictly later than the expiry. `rollupNowMs` must be a reading
 * taken from the rollup just now, not this device's clock or a kept offset.
 */
export function ordersPastExpiry(orders: readonly OpenOrder[], rollupNowMs: number): OpenOrder[] {
  return orders.filter(
    (order) => typeof order.expiresAtMs === "number" && rollupNowMs > order.expiresAtMs,
  );
}
