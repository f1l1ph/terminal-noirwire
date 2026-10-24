import type { Balance } from "./types";

export const AVAILABLE_UNKNOWN_TEXT = "Unavailable until the price updates";

export function isAvailableUnknown(balance: Balance | null | undefined): boolean {
  return balance?.availableUnknown === true;
}

/** The balance's available amount for display, or plain text when it is not known. */
export function availableLabel(balance: Balance, format: (amount: string) => string): string {
  return isAvailableUnknown(balance) ? AVAILABLE_UNKNOWN_TEXT : format(balance.available);
}
