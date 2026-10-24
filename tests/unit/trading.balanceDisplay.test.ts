import { describe, expect, it } from "vitest";
import {
  AVAILABLE_UNKNOWN_TEXT,
  availableLabel,
  isAvailableUnknown,
} from "@/lib/trading/balanceDisplay";
import type { Balance } from "@/lib/trading/types";

const KNOWN: Balance = { asset: "nUSD", available: "5.000000", reserved: "0", total: "5.000000" };
const UNKNOWN: Balance = { ...KNOWN, available: "0", availableUnknown: true };
const format = (amount: string) => `$${amount}`;

describe("availableLabel", () => {
  it("formats a known amount", () => {
    expect(availableLabel(KNOWN, format)).toBe("$5.000000");
    expect(isAvailableUnknown(KNOWN)).toBe(false);
  });

  it("shows plain text, never the placeholder zero, when the amount is unknown", () => {
    expect(availableLabel(UNKNOWN, format)).toBe(AVAILABLE_UNKNOWN_TEXT);
    expect(isAvailableUnknown(UNKNOWN)).toBe(true);
  });

  it("treats a missing balance as not unknown", () => {
    expect(isAvailableUnknown(undefined)).toBe(false);
    expect(isAvailableUnknown(null)).toBe(false);
  });
});
