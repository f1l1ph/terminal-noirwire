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

  it("turns unknown once the marks it was priced from have gone stale", () => {
    const priced: Balance = { ...KNOWN, availableValidUntilMs: 1_000 };
    expect(isAvailableUnknown(priced, 1_000)).toBe(false);
    expect(isAvailableUnknown(priced, 1_001)).toBe(true);
    expect(availableLabel(priced, format, 1_001)).toBe(AVAILABLE_UNKNOWN_TEXT);
    expect(availableLabel(priced, format, 500)).toBe("$5.000000");
    expect(isAvailableUnknown(priced), "without a time it checks against the clock").toBe(true);
    expect(isAvailableUnknown({ ...KNOWN, availableValidUntilMs: Date.now() + 60_000 })).toBe(
      false,
    );
  });

  it("treats a missing balance as not unknown", () => {
    expect(isAvailableUnknown(undefined)).toBe(false);
    expect(isAvailableUnknown(null)).toBe(false);
  });
});
