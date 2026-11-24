import { describe, expect, it } from "vitest";
import { STALE_MARK_MS } from "@/lib/market-data/selectors";
import {
  CALM_MOOD,
  nextMood,
  rawMood,
  type LocalTriggerReading,
  type Mood,
  type MoodInput,
  type RawMood,
} from "@/lib/trading/positionMood";
import type { Position, TriggerKind } from "@/lib/trading/types";

const NOW = 1_800_000_000_000;

function position(market: string, size: string, entryPrice = "100"): Position {
  return { market, size, entryPrice };
}

function freshMark(price: string) {
  return { price, time: NOW };
}

type Triggers = Record<string, Partial<Record<TriggerKind, LocalTriggerReading>>>;

function armed(price: string, long: boolean): LocalTriggerReading {
  return { price, long, armed: true };
}

function input(overrides: Partial<MoodInput> & { triggers?: Triggers }): MoodInput {
  const { triggers = {}, ...rest } = overrides;
  return {
    positions: [position("A-PERP", "1")],
    collateral: null,
    exposureUnreadable: false,
    marks: { "A-PERP": freshMark("100") },
    now: NOW,
    trigger: (market, kind) => triggers[market]?.[kind] ?? null,
    ...rest,
  };
}

function moodOf(overrides: Partial<MoodInput> & { triggers?: Triggers }): Mood {
  return nextMood(CALM_MOOD, rawMood(input(overrides)));
}

describe("mood from stop loss and take profit", () => {
  it("is calm with no open position", () => {
    expect(moodOf({ positions: [position("A-PERP", "0")] })).toEqual(CALM_MOOD);
  });

  it("warns a long as the mark falls towards its stop loss, more the closer it gets", () => {
    const far = moodOf({ triggers: { "A-PERP": { stopLoss: armed("98", true) } } });
    const close = moodOf({
      marks: { "A-PERP": freshMark("98.5") },
      triggers: { "A-PERP": { stopLoss: armed("98", true) } },
    });
    expect(far).toMatchObject({ state: "nearDanger", reason: "stopLoss" });
    expect(close.intensity).toBeGreaterThan(far.intensity);
  });

  it("warns a short as the mark rises towards its stop loss", () => {
    expect(
      moodOf({
        positions: [position("A-PERP", "-1")],
        triggers: { "A-PERP": { stopLoss: armed("102", false) } },
      }),
    ).toMatchObject({ state: "nearDanger", reason: "stopLoss" });
  });

  it("shows a long approaching its take profit, and a short approaching its own", () => {
    const long = moodOf({ triggers: { "A-PERP": { takeProfit: armed("104", true) } } });
    const short = moodOf({
      positions: [position("A-PERP", "-1")],
      triggers: { "A-PERP": { takeProfit: armed("96", false) } },
    });
    expect(long).toMatchObject({ state: "nearProfit", reason: "takeProfit" });
    expect(short).toMatchObject({ state: "nearProfit", reason: "takeProfit" });
  });

  it("ignores a trigger the exchange does not report as armed", () => {
    const unarmed: LocalTriggerReading = { price: "98", long: true, armed: false };
    expect(moodOf({ triggers: { "A-PERP": { stopLoss: unarmed } } })).toEqual(CALM_MOOD);
  });

  it("ignores a trigger with no local price", () => {
    expect(moodOf({ triggers: {} })).toEqual(CALM_MOOD);
  });

  it("ignores a trigger recorded for the other direction", () => {
    expect(moodOf({ triggers: { "A-PERP": { stopLoss: armed("98", false) } } })).toEqual(CALM_MOOD);
  });

  it("warns about a stop loss moved above the entry to lock in profit", () => {
    expect(
      moodOf({
        marks: { "A-PERP": freshMark("103") },
        triggers: { "A-PERP": { stopLoss: armed("102", true) } },
      }),
    ).toMatchObject({ state: "nearDanger", reason: "stopLoss" });
  });

  it("ignores a trigger price that is not a number", () => {
    expect(moodOf({ triggers: { "A-PERP": { stopLoss: armed("abc", true) } } })).toEqual(CALM_MOOD);
  });

  it("is at danger once the mark is past the stop loss", () => {
    expect(
      moodOf({
        marks: { "A-PERP": freshMark("97") },
        triggers: { "A-PERP": { stopLoss: armed("98", true) } },
      }),
    ).toEqual({ state: "atDanger", intensity: 1, reason: "stopLoss" });
  });

  it("is at profit once the mark is past the take profit price", () => {
    expect(
      moodOf({
        marks: { "A-PERP": freshMark("105") },
        triggers: { "A-PERP": { takeProfit: armed("104", true) } },
      }),
    ).toEqual({ state: "atProfit", intensity: 1, reason: "takeProfit" });
  });
});

describe("mood across positions and freshness", () => {
  const two = [position("A-PERP", "1"), position("B-PERP", "1")];
  const marks = { "A-PERP": freshMark("100"), "B-PERP": freshMark("100") };

  it("lets danger win over profit on another position", () => {
    expect(
      moodOf({
        positions: two,
        marks,
        triggers: {
          "A-PERP": { takeProfit: armed("101", true) },
          "B-PERP": { stopLoss: armed("98", true) },
        },
      }).state,
    ).toBe("nearDanger");
  });

  it("reads a stale mark as unknown", () => {
    expect(
      moodOf({
        marks: { "A-PERP": { price: "100", time: NOW - STALE_MARK_MS - 1 } },
        triggers: { "A-PERP": { takeProfit: armed("101", true) } },
      }).state,
    ).toBe("unknown");
  });

  it("reads a mark stamped in the future as unknown", () => {
    expect(moodOf({ marks: { "A-PERP": { price: "100", time: NOW + 3_600_000 } } }).state).toBe(
      "unknown",
    );
  });

  it("reads a missing mark as unknown", () => {
    expect(moodOf({ marks: { "A-PERP": null } }).state).toBe("unknown");
  });

  it("shows no profit while another position has no fresh mark", () => {
    expect(
      moodOf({
        positions: two,
        marks: { "A-PERP": freshMark("100"), "B-PERP": null },
        triggers: { "A-PERP": { takeProfit: armed("101", true) } },
      }).state,
    ).toBe("unknown");
  });

  it("still shows a known danger while another position has no fresh mark", () => {
    expect(
      moodOf({
        positions: two,
        marks: { "A-PERP": freshMark("100"), "B-PERP": null },
        triggers: { "A-PERP": { stopLoss: armed("98", true) } },
      }).state,
    ).toBe("nearDanger");
  });

  it("reads unreadable exposure as unknown, with fresh prices, and says the account is the cause", () => {
    expect(moodOf({ exposureUnreadable: true })).toMatchObject({
      state: "unknown",
      reason: "accountUnreadable",
    });
  });

  it("says a missing price is the cause when the price is what is missing", () => {
    expect(moodOf({ marks: { "A-PERP": null } })).toMatchObject({
      state: "unknown",
      reason: "noPrice",
    });
  });
});

describe("mood from the estimated liquidation", () => {
  const long = { ...position("A-PERP", "100", "0.1"), quote: "-10", maintenanceMarginBps: 500 };
  const short = { ...position("A-PERP", "-100", "0.1"), quote: "10", maintenanceMarginBps: 500 };

  it("is calm while the liquidation estimate is far away", () => {
    expect(
      moodOf({ positions: [long], collateral: "1", marks: { "A-PERP": freshMark("0.1") } }),
    ).toEqual(CALM_MOOD);
  });

  it("warns a long near its estimated liquidation price", () => {
    expect(
      moodOf({ positions: [long], collateral: "1", marks: { "A-PERP": freshMark("0.0975") } }),
    ).toMatchObject({ state: "nearDanger", reason: "liquidation" });
  });

  it("warns a short near its estimated liquidation price", () => {
    expect(
      moodOf({ positions: [short], collateral: "1", marks: { "A-PERP": freshMark("0.1025") } }),
    ).toMatchObject({ state: "nearDanger", reason: "liquidation" });
  });

  it("is at danger when the account is already below maintenance", () => {
    expect(
      moodOf({ positions: [long], collateral: "1", marks: { "A-PERP": freshMark("0.09") } }),
    ).toEqual({ state: "atDanger", intensity: 1, reason: "liquidation" });
  });

  it("has no liquidation target without the account's collateral", () => {
    expect(
      moodOf({ positions: [long], collateral: null, marks: { "A-PERP": freshMark("0.09") } }),
    ).toEqual(CALM_MOOD);
  });
});

describe("mood hysteresis", () => {
  const raw = (overrides: Partial<RawMood>): RawMood => ({
    unknown: null,
    danger: null,
    profit: null,
    ...overrides,
  });
  const danger = (bps: number): RawMood => raw({ danger: { bps, reason: "stopLoss" } });
  const profit = (bps: number): RawMood => raw({ profit: { bps } });
  const inDanger: Mood = { state: "nearDanger", intensity: 0.1, reason: "stopLoss" };
  const inProfit: Mood = { state: "nearProfit", intensity: 0.1, reason: "takeProfit" };

  it("enters danger at 300 bps and not before", () => {
    expect(nextMood(CALM_MOOD, danger(300)).state).toBe("nearDanger");
    expect(nextMood(CALM_MOOD, danger(301)).state).toBe("calm");
  });

  it("leaves danger only above 360 bps", () => {
    expect(nextMood(inDanger, danger(360)).state).toBe("nearDanger");
    expect(nextMood(inDanger, danger(361)).state).toBe("calm");
  });

  it("enters profit at 500 bps and not before", () => {
    expect(nextMood(CALM_MOOD, profit(500)).state).toBe("nearProfit");
    expect(nextMood(CALM_MOOD, profit(501)).state).toBe("calm");
  });

  it("leaves profit only above 575 bps", () => {
    expect(nextMood(inProfit, profit(575)).state).toBe("nearProfit");
    expect(nextMood(inProfit, profit(576)).state).toBe("calm");
  });

  it("keeps a visible intensity inside the leave band", () => {
    expect(nextMood(inDanger, danger(350)).intensity).toBeGreaterThan(0);
  });

  it("switches to at-danger at once on crossing, even from calm", () => {
    expect(nextMood(CALM_MOOD, danger(0))).toMatchObject({ state: "atDanger", intensity: 1 });
  });

  it("quantizes intensity to tenths", () => {
    const { intensity } = nextMood(CALM_MOOD, danger(200));
    expect(Math.round(intensity * 10)).toBe(intensity * 10);
  });
});
