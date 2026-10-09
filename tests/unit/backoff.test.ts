import { describe, expect, it } from "vitest";
import { backoffDelayMs } from "@/lib/market-data/backoff";

describe("backoffDelayMs", () => {
  it("doubles each attempt up to the ceiling", () => {
    expect(backoffDelayMs(1, 500, 10_000, 2)).toBe(500);
    expect(backoffDelayMs(2, 500, 10_000, 2)).toBe(1_000);
    expect(backoffDelayMs(3, 500, 10_000, 2)).toBe(2_000);
    expect(backoffDelayMs(4, 500, 10_000, 2)).toBe(4_000);
  });

  it("never exceeds the ceiling", () => {
    expect(backoffDelayMs(10, 500, 10_000, 2)).toBe(10_000);
  });
});
