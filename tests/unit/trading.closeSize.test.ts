import { describe, expect, it } from "vitest";
import { reduceOnlyLots } from "@/lib/trading/closeSize";

const base = { price: 100_000n, minSize: 1n, minNotional: 1_000_000n };

describe("reduceOnlyLots", () => {
  it("lifts a full close of a dust position to the lots the minimum value needs", () => {
    expect(reduceOnlyLots({ ...base, requested: 5n, position: 5n })).toBe(10n);
  });

  it("rounds the lots for the minimum value up", () => {
    expect(reduceOnlyLots({ ...base, requested: 3n, position: 3n, price: 300_000n })).toBe(4n);
  });

  it("treats a short position the same as a long one", () => {
    expect(reduceOnlyLots({ ...base, requested: 5n, position: -5n })).toBe(10n);
  });

  it("lifts a close that is below the minimum size", () => {
    expect(
      reduceOnlyLots({ ...base, requested: 1n, position: 1n, minSize: 3n, minNotional: 0n }),
    ).toBe(3n);
  });

  it("keeps a full close that already clears both minimums", () => {
    expect(reduceOnlyLots({ ...base, requested: 20n, position: 20n })).toBe(20n);
  });

  it("keeps a close larger than the position as typed", () => {
    expect(reduceOnlyLots({ ...base, requested: 30n, position: 20n })).toBe(30n);
  });

  it("leaves a partial reduction alone", () => {
    expect(reduceOnlyLots({ ...base, requested: 5n, position: 20n })).toBe(5n);
  });

  it("leaves the size alone when no position is known or the price is unusable", () => {
    expect(reduceOnlyLots({ ...base, requested: 5n, position: 0n })).toBe(5n);
    expect(reduceOnlyLots({ ...base, requested: 5n, position: 5n, price: 0n })).toBe(5n);
  });
});
