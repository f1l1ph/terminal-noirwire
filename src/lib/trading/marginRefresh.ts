import type { TraderState } from "./types";

/** How long before the available figure goes stale the trader's state is re-read, so a fresh one lands first. */
export const MARGIN_REFRESH_LEAD_MS = 10_000;

/** The least time between two re-reads of one account, whatever the marks do. */
export const MARGIN_REFRESH_MIN_SPACING_MS = 2_000;

/** How long after the figure goes stale the first re-read after expiry runs. */
export const MARGIN_REFRESH_AFTER_EXPIRY_MS = 250;

/** While the figure stays stale, how often it is re-read until a fresh mark prices it again. */
export const MARGIN_REFRESH_STALE_RETRY_MS = 5_000;

/** The least time between two re-valuations of the account against newer marks; marks arriving faster are coalesced into one. */
export const MARK_REPRICE_MIN_SPACING_MS = 2_000;

/** How long to wait before re-valuing the account now, given when it was last re-valued (null if never). */
export function markRepriceDelayMs(nowMs: number, lastRepricedAtMs: number | null): number {
  if (lastRepricedAtMs === null) return 0;
  return Math.max(lastRepricedAtMs + MARK_REPRICE_MIN_SPACING_MS, nowMs) - nowMs;
}

/** Whether a newer mark for any of `marketIds` can change the account's valuation: it holds a position or resting orders there. */
export function hasExposureIn(
  state: Pick<TraderState, "positions" | "openOrders">,
  marketIds: readonly string[],
): boolean {
  return marketIds.some(
    (id) => id in state.positions || state.openOrders.some((order) => order.market === id),
  );
}

/**
 * How long to wait before the next re-read of an account whose available
 * figure is valid until `validUntilMs`. `lastReadAtMs` is when the current
 * figure was last re-read (null if not at all). One early read ahead of
 * expiry, one just after it, then one every `MARGIN_REFRESH_STALE_RETRY_MS`
 * while it stays stale, so a mark that stops moving costs a slow retry, never
 * a loop, and the figure comes back as soon as marks resume.
 */
export function nextMarginRefreshDelayMs(
  validUntilMs: number,
  nowMs: number,
  lastReadAtMs: number | null,
): number {
  const earlyAtMs = validUntilMs - MARGIN_REFRESH_LEAD_MS;
  const afterExpiryAtMs = validUntilMs + MARGIN_REFRESH_AFTER_EXPIRY_MS;
  if (lastReadAtMs !== null && lastReadAtMs >= validUntilMs) {
    return Math.max(lastReadAtMs + MARGIN_REFRESH_STALE_RETRY_MS, nowMs) - nowMs;
  }
  const targetMs = lastReadAtMs === null || lastReadAtMs < earlyAtMs ? earlyAtMs : afterExpiryAtMs;
  const earliestMs = lastReadAtMs === null ? 0 : lastReadAtMs + MARGIN_REFRESH_MIN_SPACING_MS;
  return Math.max(targetMs, earliestMs, nowMs) - nowMs;
}
