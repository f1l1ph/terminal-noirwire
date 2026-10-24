import type { Balance } from "./types";

export const AVAILABLE_UNKNOWN_TEXT = "Unavailable until the price updates";

/**
 * Unknown when the balance says so, or when `now` (the current time if not
 * given) is past the moment the marks it was priced from went stale: a cached
 * figure never outlives them.
 */
export function isAvailableUnknown(
  balance: Balance | null | undefined,
  now: number = Date.now(),
): boolean {
  if (balance?.availableUnknown === true) return true;
  return balance?.availableValidUntilMs !== undefined && now > balance.availableValidUntilMs;
}

/** The balance's available amount for display, or plain text when it is not known. */
export function availableLabel(
  balance: Balance,
  format: (amount: string) => string,
  now?: number,
): string {
  return isAvailableUnknown(balance, now) ? AVAILABLE_UNKNOWN_TEXT : format(balance.available);
}
