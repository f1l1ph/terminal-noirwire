import { describe, expect, it } from "vitest";
import { STALE_MARK_MS } from "@/lib/market-data/selectors";
import {
  CALM_MOOD,
  gaugeMarker,
  nextMood,
  positionGauge,
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
    entryLiquidation: () => null,
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

  const unarmed: LocalTriggerReading = { price: "98", long: true, armed: false };
  it.each<[string, Triggers]>([
    [
      "ignores a trigger the exchange does not report as armed",
      { "A-PERP": { stopLoss: unarmed } },
    ],
    ["ignores a trigger with no local price", {}],
    [
      "ignores a trigger recorded for the other direction",
      { "A-PERP": { stopLoss: armed("98", false) } },
    ],
    [
      "ignores a trigger price that is not a number",
      { "A-PERP": { stopLoss: armed("abc", true) } },
    ],
  ])("%s", (_name, triggers) => {
    expect(moodOf({ triggers })).toEqual(CALM_MOOD);
  });

  it("warns about a stop loss moved above the entry to lock in profit", () => {
    expect(
      moodOf({
        marks: { "A-PERP": freshMark("103") },
        triggers: { "A-PERP": { stopLoss: armed("102", true) } },
      }),
    ).toMatchObject({ state: "nearDanger", reason: "stopLoss" });
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

  it.each<[string, Partial<MoodInput> & { triggers?: Triggers }]>([
    [
      "reads a stale mark as unknown",
      {
        marks: { "A-PERP": { price: "100", time: NOW - STALE_MARK_MS - 1 } },
        triggers: { "A-PERP": { takeProfit: armed("101", true) } },
      },
    ],
    [
      "reads a mark stamped in the future as unknown",
      { marks: { "A-PERP": { price: "100", time: NOW + 3_600_000 } } },
    ],
    ["reads a missing mark as unknown", { marks: { "A-PERP": null } }],
  ])("%s", (_name, overrides) => {
    expect(moodOf(overrides).state).toBe("unknown");
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

describe("mood from the entry liquidation estimate", () => {
  const longEstimate = (position: Position) => (Number(position.size) > 0 ? "90" : null);
  const shortEstimate = (position: Position) => (Number(position.size) < 0 ? "110" : null);
  const longAt = (price: string) =>
    moodOf({ entryLiquidation: longEstimate, marks: { "A-PERP": freshMark(price) } });
  const shortAt = (price: string) =>
    moodOf({
      positions: [position("A-PERP", "-1")],
      entryLiquidation: shortEstimate,
      marks: { "A-PERP": freshMark(price) },
    });

  it("warns a long near the estimate and a short near its own", () => {
    expect(longAt("92")).toMatchObject({ state: "nearDanger", reason: "liquidation" });
    expect(shortAt("108")).toMatchObject({ state: "nearDanger", reason: "liquidation" });
  });

  it("stays calm while the mark is far from the estimate", () => {
    expect(longAt("100")).toEqual(CALM_MOOD);
    expect(shortAt("100")).toEqual(CALM_MOOD);
  });

  it("is at danger once the mark is past the estimate", () => {
    expect(longAt("89")).toEqual({ state: "atDanger", intensity: 1, reason: "liquidation" });
    expect(shortAt("111")).toEqual({ state: "atDanger", intensity: 1, reason: "liquidation" });
  });

  it("ignores the estimate when the account carries its own liquidation", () => {
    const withQuote = {
      ...position("A-PERP", "100", "0.1"),
      quote: "-10",
      maintenanceMarginBps: 500,
    };
    expect(
      moodOf({
        positions: [withQuote],
        collateral: "1",
        marks: { "A-PERP": freshMark("0.1") },
        entryLiquidation: () => "0.0999",
      }),
    ).toEqual(CALM_MOOD);
  });

  it("ignores the estimate when the account exposure is unreadable", () => {
    expect(
      moodOf({
        exposureUnreadable: true,
        entryLiquidation: () => "99.9",
      }).reason,
    ).toBe("accountUnreadable");
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

  it.each<[string, Mood, RawMood, string]>([
    ["enters danger at 300 bps", CALM_MOOD, danger(300), "nearDanger"],
    ["does not enter danger at 301 bps", CALM_MOOD, danger(301), "calm"],
    ["stays in danger at 360 bps", inDanger, danger(360), "nearDanger"],
    ["leaves danger above 360 bps", inDanger, danger(361), "calm"],
    ["enters profit at 500 bps", CALM_MOOD, profit(500), "nearProfit"],
    ["does not enter profit at 501 bps", CALM_MOOD, profit(501), "calm"],
    ["stays in profit at 575 bps", inProfit, profit(575), "nearProfit"],
    ["leaves profit above 575 bps", inProfit, profit(576), "calm"],
  ])("%s", (_name, from, raw, expected) => {
    expect(nextMood(from, raw).state).toBe(expected);
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

describe("risk gauge", () => {
  function markerOf(overrides: Partial<MoodInput> & { triggers?: Triggers }): number | null {
    const gauge = positionGauge(input(overrides));
    return gauge === null ? null : gaugeMarker(gauge);
  }

  it("places a long between its stop loss and take profit", () => {
    const overrides = {
      triggers: { "A-PERP": { stopLoss: armed("98", true), takeProfit: armed("104", true) } },
    };
    expect(positionGauge(input(overrides))).toEqual({
      dangerBps: 200,
      dangerReason: "stopLoss",
      profitBps: 400,
    });
    expect(markerOf(overrides)).toBeCloseTo(1 / 3, 6);
  });

  it("places a short between its stop loss and take profit", () => {
    const marker = markerOf({
      positions: [position("A-PERP", "-1")],
      triggers: { "A-PERP": { stopLoss: armed("102", false), takeProfit: armed("96", false) } },
    });
    expect(marker).toBeCloseTo(1 / 3, 6);
  });

  it("fills the bar with 1000 bps of room when only the danger end is known", () => {
    expect(markerOf({ triggers: { "A-PERP": { stopLoss: armed("98", true) } } })).toBeCloseTo(
      0.2,
      6,
    );
    expect(markerOf({ triggers: { "A-PERP": { stopLoss: armed("80", true) } } })).toBe(1);
  });

  it("fills the bar with 1000 bps of room when only the take profit is known", () => {
    const gauge = positionGauge(
      input({ triggers: { "A-PERP": { takeProfit: armed("104", true) } } }),
    );
    expect(gauge).toEqual({ dangerBps: null, dangerReason: null, profitBps: 400 });
    expect(markerOf({ triggers: { "A-PERP": { takeProfit: armed("104", true) } } })).toBeCloseTo(
      0.6,
      6,
    );
    expect(markerOf({ triggers: { "A-PERP": { takeProfit: armed("200", true) } } })).toBe(0);
  });

  it("sits at the danger end once the danger target is reached", () => {
    expect(
      markerOf({
        marks: { "A-PERP": freshMark("97") },
        triggers: { "A-PERP": { stopLoss: armed("98", true), takeProfit: armed("104", true) } },
      }),
    ).toBe(0);
    expect(
      markerOf({
        marks: { "A-PERP": freshMark("97") },
        triggers: { "A-PERP": { stopLoss: armed("98", true) } },
      }),
    ).toBe(0);
  });

  it("sits at the profit end once the take profit is reached", () => {
    expect(
      markerOf({
        marks: { "A-PERP": freshMark("105") },
        triggers: { "A-PERP": { stopLoss: armed("98", true), takeProfit: armed("104", true) } },
      }),
    ).toBe(1);
    expect(
      markerOf({
        marks: { "A-PERP": freshMark("105") },
        triggers: { "A-PERP": { takeProfit: armed("104", true) } },
      }),
    ).toBe(1);
  });

  it("follows the position nearest its danger, with that position's own take profit", () => {
    const gauge = positionGauge(
      input({
        positions: [position("A-PERP", "1"), position("B-PERP", "1")],
        marks: { "A-PERP": freshMark("100"), "B-PERP": freshMark("100") },
        triggers: {
          "A-PERP": { stopLoss: armed("98", true), takeProfit: armed("101", true) },
          "B-PERP": { stopLoss: armed("99", true), takeProfit: armed("110", true) },
        },
      }),
    );
    expect(gauge).toEqual({ dangerBps: 100, dangerReason: "stopLoss", profitBps: 1000 });
    expect(gaugeMarker(gauge!)).toBeCloseTo(100 / 1100, 6);
  });

  it("follows the nearest take profit when no position has a danger target", () => {
    const gauge = positionGauge(
      input({
        positions: [position("A-PERP", "1"), position("B-PERP", "1")],
        marks: { "A-PERP": freshMark("100"), "B-PERP": freshMark("100") },
        triggers: {
          "A-PERP": { takeProfit: armed("110", true) },
          "B-PERP": { takeProfit: armed("102", true) },
        },
      }),
    );
    expect(gauge).toEqual({ dangerBps: null, dangerReason: null, profitBps: 200 });
  });

  it("names the liquidation estimate as the danger when it is the nearer one", () => {
    const gauge = positionGauge(
      input({
        entryLiquidation: () => "97",
        triggers: { "A-PERP": { stopLoss: armed("90", true) } },
      }),
    );
    expect(gauge).toMatchObject({ dangerBps: 300, dangerReason: "liquidation" });
  });

  it("draws no bar with no open position, no target, or no fresh price", () => {
    expect(positionGauge(input({ positions: [position("A-PERP", "0")] }))).toBeNull();
    expect(positionGauge(input({}))).toBeNull();
    expect(
      positionGauge(
        input({
          marks: { "A-PERP": null },
          triggers: { "A-PERP": { stopLoss: armed("98", true) } },
        }),
      ),
    ).toBeNull();
  });
});
