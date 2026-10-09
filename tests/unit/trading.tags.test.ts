import { describe, expect, it } from "vitest";
import { deriveOwnFills, isOwnFill } from "@/lib/trading/tags";
import type { PublicFill } from "@/lib/market-data/types";

function fill(overrides: Partial<PublicFill> = {}): PublicFill {
  return {
    market: "NSOL-PERP",
    price: "150.000000",
    size: "1.000000",
    takerSide: "buy",
    takerTag: "111",
    makerTag: "222",
    timestampMs: 1000,
    sequence: 1,
    ...overrides,
  };
}

describe("isOwnFill", () => {
  it("matches a fill where this browser's known tag is the taker", () => {
    expect(isOwnFill(fill({ takerTag: "abc" }), new Set(["abc"]))).toBe(true);
  });

  it("matches a fill where this browser's known tag is the maker", () => {
    expect(isOwnFill(fill({ makerTag: "abc" }), new Set(["abc"]))).toBe(true);
  });

  it("does not match a fill carrying neither known tag", () => {
    expect(isOwnFill(fill({ takerTag: "x", makerTag: "y" }), new Set(["abc"]))).toBe(false);
  });

  it("never matches with an empty own-tag set", () => {
    expect(isOwnFill(fill(), new Set())).toBe(false);
  });
});

describe("deriveOwnFills", () => {
  it("reports the taker's own side when this trader was the taker", () => {
    const records = deriveOwnFills(
      [fill({ takerTag: "mine", takerSide: "buy" })],
      new Set(["mine"]),
    );
    expect(records).toEqual([
      {
        sequence: 1,
        market: "NSOL-PERP",
        side: "buy",
        price: "150.000000",
        size: "1.000000",
        timestampMs: 1000,
        role: "taker",
        tag: "mine",
      },
    ]);
  });

  it("flips to the opposite side when this trader was the resting maker", () => {
    const records = deriveOwnFills(
      [fill({ makerTag: "mine", takerSide: "buy" })],
      new Set(["mine"]),
    );
    expect(records[0]).toMatchObject({ side: "sell", role: "maker", tag: "mine" });
  });

  it("skips a fill that matches no known tag", () => {
    expect(deriveOwnFills([fill()], new Set(["unrelated"]))).toEqual([]);
  });

  it("keeps fills in the order given, not resorted", () => {
    const records = deriveOwnFills(
      [fill({ sequence: 5, takerTag: "mine" }), fill({ sequence: 2, takerTag: "mine" })],
      new Set(["mine"]),
    );
    expect(records.map((r) => r.sequence)).toEqual([5, 2]);
  });
});
