import { describe, expect, it } from "vitest";
import { STALE_MARK_MS } from "@/lib/market-data/selectors";
import {
  CALM_MOOD,
  gaugeMarker,
  nextMood,
  positionGauge,
  rawMood,
  sameMood,
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

function longAt(mark: string, triggers: Triggers[string]): Mood {
  return moodOf({ marks: { "A-PERP": freshMark(mark) }, triggers: { "A-PERP": triggers } });
}

describe("danger target selection", () => {
  it("is calm and untoned with no open position", () => {
    expect(moodOf({ positions: [position("A-PERP", "0")] })).toEqual(CALM_MOOD);
  });

  it("follows the stop loss of a long, and a short's own", () => {
    const long = longAt("99", { stopLoss: armed("98", true) });
    const short = moodOf({
      positions: [position("A-PERP", "-1")],
      marks: { "A-PERP": freshMark("101") },
      triggers: { "A-PERP": { stopLoss: armed("102", false) } },
    });
    for (const mood of [long, short]) {
      expect(mood).toMatchObject({ tone: "danger", reason: "stopLoss", state: "nearDanger" });
      expect(mood.progress).toBeCloseTo(0.5, 6);
    }
    expect(long.focus).toEqual({ market: "A-PERP", price: "98", kind: "stopLoss" });
    expect(short.focus).toEqual({ market: "A-PERP", price: "102", kind: "stopLoss" });
  });

  it("prefers the stop loss over a farther liquidation estimate", () => {
    const mood = moodOf({
      marks: { "A-PERP": freshMark("99") },
      entryLiquidation: () => "90",
      triggers: { "A-PERP": { stopLoss: armed("98", true) } },
    });
    expect(mood).toMatchObject({ reason: "stopLoss", focus: { price: "98", kind: "stopLoss" } });
  });

  it("follows the take-profit band, not a calm liquidation reading, for the tone and focus", () => {
    const mood = nextMood(CALM_MOOD, {
      unknown: null,
      danger: {
        progress: 0.3,
        bps: 200,
        reached: false,
        reason: "liquidation",
        market: "A-PERP",
        price: "90",
      },
      profit: { progress: 0.6, bps: 100, reached: false, market: "A-PERP", price: "110" },
    });
    expect(mood).toMatchObject({
      state: "nearProfit",
      reason: "takeProfit",
      tone: "profit",
      focus: { market: "A-PERP", price: "110", kind: "takeProfit" },
    });
    expect(mood.progress).toBeCloseTo(0.6, 6);
  });

  it("uses the liquidation estimate only when there is no stop loss", () => {
    const mood = moodOf({ marks: { "A-PERP": freshMark("95") }, entryLiquidation: () => "90" });
    expect(mood).toMatchObject({
      tone: "danger",
      reason: "liquidation",
      state: "nearDanger",
      focus: { market: "A-PERP", price: "90" },
    });
    expect(mood.progress).toBeCloseTo(0.5, 6);
  });

  it("ignores a stop loss that is not armed and falls back to the liquidation", () => {
    const mood = moodOf({
      marks: { "A-PERP": freshMark("95") },
      entryLiquidation: () => "90",
      triggers: { "A-PERP": { stopLoss: { price: "98", long: true, armed: false } } },
    });
    expect(mood.reason).toBe("liquidation");
  });

  it("targets the liquidation when it would be reached before the stop loss, for a long", () => {
    const mood = moodOf({
      marks: { "A-PERP": freshMark("99.5") },
      entryLiquidation: () => "99",
      triggers: { "A-PERP": { stopLoss: armed("98", true) } },
    });
    expect(mood).toMatchObject({ reason: "liquidation", focus: { price: "99" } });
    expect(mood.progress).toBeCloseTo(0.5, 6);
  });

  it("targets the liquidation when it would be reached before the stop loss, for a short", () => {
    const mood = moodOf({
      positions: [position("A-PERP", "-1")],
      marks: { "A-PERP": freshMark("100.5") },
      entryLiquidation: () => "101",
      triggers: { "A-PERP": { stopLoss: armed("102", false) } },
    });
    expect(mood).toMatchObject({ reason: "liquidation", focus: { price: "101" } });
    expect(mood.progress).toBeCloseTo(0.5, 6);
  });

  it("keeps a short's stop loss when the liquidation lies beyond it", () => {
    const mood = moodOf({
      positions: [position("A-PERP", "-1")],
      marks: { "A-PERP": freshMark("101") },
      entryLiquidation: () => "110",
      triggers: { "A-PERP": { stopLoss: armed("102", false) } },
    });
    expect(mood.reason).toBe("stopLoss");
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
    expect(moodOf({ marks: { "A-PERP": freshMark("99") }, triggers })).toEqual(CALM_MOOD);
  });
});

describe("progress from the entry price", () => {
  it("is zero at the entry and one at the target, and clamps outside", () => {
    const stop = { stopLoss: armed("98", true) };
    expect(longAt("100", stop).tone).toBeNull();
    expect(longAt("101", stop).tone).toBeNull();
    expect(longAt("99", stop).progress).toBeCloseTo(0.5, 6);
    expect(longAt("98", stop)).toMatchObject({ state: "atDanger", progress: 1, intensity: 1 });
    expect(longAt("97", stop)).toMatchObject({ state: "atDanger", progress: 1, intensity: 1 });
  });

  it("measures a profit the same way from the entry", () => {
    const takeProfit = { takeProfit: armed("104", true) };
    expect(longAt("100", takeProfit).tone).toBeNull();
    expect(longAt("102", takeProfit)).toMatchObject({ tone: "profit", reason: "takeProfit" });
    expect(longAt("102", takeProfit).progress).toBeCloseTo(0.5, 6);
    expect(longAt("104", takeProfit)).toMatchObject({ state: "atProfit", intensity: 1 });
    expect(longAt("105", takeProfit)).toMatchObject({ state: "atProfit", progress: 1 });
  });

  it("mirrors a short's take profit", () => {
    const mood = moodOf({
      positions: [position("A-PERP", "-1")],
      marks: { "A-PERP": freshMark("98") },
      triggers: { "A-PERP": { takeProfit: armed("96", false) } },
    });
    expect(mood).toMatchObject({ tone: "profit", state: "nearProfit" });
    expect(mood.progress).toBeCloseTo(0.5, 6);
  });

  it("falls back to a 300 bps window when the entry price cannot be read", () => {
    const mood = moodOf({
      positions: [position("A-PERP", "1", "abc")],
      marks: { "A-PERP": freshMark("99") },
      triggers: { "A-PERP": { stopLoss: armed("98", true) } },
    });
    expect(mood.progress).toBeCloseTo(1 - 101.01 / 300, 3);
  });

  it("falls back to the window when the stop sits at or beyond break-even", () => {
    const mood = longAt("103", { stopLoss: armed("102", true) });
    expect(mood).toMatchObject({ tone: "danger", reason: "stopLoss" });
    expect(mood.progress).toBeCloseTo(1 - 97.09 / 300, 3);
    expect(longAt("102.5", { stopLoss: armed("100", true) }).progress).toBeCloseTo(
      1 - 243.9 / 300,
      3,
    );
  });

  it("falls back to a 500 bps window for a take profit with no usable entry", () => {
    const mood = moodOf({
      positions: [position("A-PERP", "1", "0")],
      triggers: { "A-PERP": { takeProfit: armed("104", true) } },
    });
    expect(mood).toMatchObject({ tone: "profit" });
    expect(mood.progress).toBeCloseTo(0.2, 6);
  });

  it("is at danger once the mark is past a short's stop loss", () => {
    expect(
      moodOf({
        positions: [position("A-PERP", "-1")],
        marks: { "A-PERP": freshMark("103") },
        triggers: { "A-PERP": { stopLoss: armed("102", false) } },
      }),
    ).toMatchObject({ state: "atDanger", reason: "stopLoss", intensity: 1, progress: 1 });
  });

  it("is at danger with no price to show when the account is already below maintenance", () => {
    const long = { ...position("A-PERP", "100", "0.1"), quote: "-10", maintenanceMarginBps: 500 };
    expect(
      moodOf({ positions: [long], collateral: "1", marks: { "A-PERP": freshMark("0.09") } }),
    ).toMatchObject({
      state: "atDanger",
      reason: "liquidation",
      tone: "danger",
      intensity: 1,
      focus: { market: "A-PERP", price: null },
    });
  });
});

describe("continuous intensity", () => {
  it("is the square of progress, never stepped", () => {
    const seen = new Set<number>();
    for (let tick = 1; tick < 40; tick += 1) {
      const mark = (100 - tick * 0.05).toFixed(2);
      const mood = longAt(mark, { stopLoss: armed("98", true) });
      expect(mood.intensity).toBeCloseTo(mood.progress * mood.progress, 9);
      seen.add(mood.intensity);
    }
    expect(seen.size).toBe(39);
    expect([...seen].some((value) => Math.round(value * 10) !== value * 10)).toBe(true);
  });

  it("rises with every price move towards the stop and falls on the way back", () => {
    const stop = { stopLoss: armed("98", true) };
    const a = longAt("99.4", stop).intensity;
    const b = longAt("99.3", stop).intensity;
    const c = longAt("99.4", stop).intensity;
    expect(b).toBeGreaterThan(a);
    expect(c).toBe(a);
  });
});

describe("several positions", () => {
  const two = [position("A-PERP", "1"), position("B-PERP", "1")];

  it("follows the position furthest towards its danger target", () => {
    const mood = moodOf({
      positions: two,
      marks: { "A-PERP": freshMark("99"), "B-PERP": freshMark("99.8") },
      triggers: {
        "A-PERP": { stopLoss: armed("98", true) },
        "B-PERP": { stopLoss: armed("98", true) },
      },
    });
    expect(mood.focus?.market).toBe("A-PERP");
    expect(mood.progress).toBeCloseTo(0.5, 6);
  });

  it("measures each position against its own entry", () => {
    const mood = moodOf({
      positions: [position("A-PERP", "1", "100"), position("B-PERP", "1", "50")],
      marks: { "A-PERP": freshMark("99"), "B-PERP": freshMark("47") },
      triggers: {
        "A-PERP": { stopLoss: armed("98", true) },
        "B-PERP": { stopLoss: armed("46", true) },
      },
    });
    expect(mood.focus?.market).toBe("B-PERP");
    expect(mood.progress).toBeCloseTo(0.75, 6);
  });

  it("lets a profit band win the glow over a danger reading that has only begun", () => {
    const mood = moodOf({
      positions: two,
      marks: { "A-PERP": freshMark("100.8"), "B-PERP": freshMark("99.9") },
      triggers: {
        "A-PERP": { takeProfit: armed("101", true) },
        "B-PERP": { stopLoss: armed("98", true) },
      },
    });
    expect(mood).toMatchObject({
      state: "nearProfit",
      tone: "profit",
      focus: { market: "A-PERP", kind: "takeProfit" },
    });
  });

  it("shows the profit glow while no danger has begun, from the position furthest along", () => {
    const mood = moodOf({
      positions: two,
      marks: { "A-PERP": freshMark("100"), "B-PERP": freshMark("101") },
      triggers: {
        "A-PERP": { stopLoss: armed("98", true), takeProfit: armed("102", true) },
        "B-PERP": { takeProfit: armed("102", true) },
      },
    });
    expect(mood).toMatchObject({ tone: "profit", focus: { market: "B-PERP", price: "102" } });
  });

  it("tones and focuses on the reached take profit, not a faint stop on another position", () => {
    const mood = moodOf({
      positions: two,
      marks: { "A-PERP": freshMark("99.9"), "B-PERP": freshMark("102") },
      triggers: {
        "A-PERP": { stopLoss: armed("98", true) },
        "B-PERP": { takeProfit: armed("102", true) },
      },
    });
    expect(mood).toMatchObject({
      state: "atProfit",
      reason: "takeProfit",
      tone: "profit",
      progress: 1,
      intensity: 1,
      focus: { market: "B-PERP", price: "102", kind: "takeProfit" },
    });
  });

  it("lets a danger band win over profit on another position", () => {
    expect(
      moodOf({
        positions: two,
        marks: { "A-PERP": freshMark("101.5"), "B-PERP": freshMark("99") },
        triggers: {
          "A-PERP": { takeProfit: armed("102", true) },
          "B-PERP": { stopLoss: armed("98", true) },
        },
      }).state,
    ).toBe("nearDanger");
  });
});

describe("the wizard band and the glow", () => {
  it("shows a faint glow while the band is still calm", () => {
    const mood = longAt("99.5", { stopLoss: armed("98", true) });
    expect(mood).toMatchObject({
      state: "calm",
      tone: "danger",
      reason: "stopLoss",
      focus: { market: "A-PERP", price: "98" },
    });
    expect(mood.intensity).toBeCloseTo(0.0625, 6);
  });

  it("names the take profit as the reason of a calm profit glow", () => {
    expect(longAt("100.5", { takeProfit: armed("104", true) })).toMatchObject({
      state: "calm",
      tone: "profit",
      reason: "takeProfit",
    });
  });

  it("is untoned when the mark sits at the entry", () => {
    expect(longAt("100", { stopLoss: armed("98", true) })).toEqual(CALM_MOOD);
  });

  it("matches the worked case at each step", () => {
    const base = {
      positions: [position("SOL-PERP", "0.208", "71.27")],
      entryLiquidation: () => "14.77",
      triggers: {
        "SOL-PERP": { stopLoss: armed("70.40", true), takeProfit: armed("72.53", true) },
      },
    };
    const at = (mark: string) => moodOf({ ...base, marks: { "SOL-PERP": freshMark(mark) } });

    const entry = at("71.16");
    expect(entry).toMatchObject({
      state: "calm",
      tone: "danger",
      reason: "stopLoss",
      focus: { market: "SOL-PERP", price: "70.40" },
    });
    expect(entry.progress).toBeCloseTo(0.126, 3);
    expect(entry.intensity).toBeCloseTo(0.016, 3);

    const close = at("70.57");
    expect(close.state).toBe("nearDanger");
    expect(close.progress).toBeCloseTo(0.805, 3);
    expect(close.intensity).toBeCloseTo(0.648, 2);

    expect(at("70.40")).toMatchObject({ state: "atDanger", intensity: 1, progress: 1 });
  });
});

describe("mood across freshness", () => {
  const two = [position("A-PERP", "1"), position("B-PERP", "1")];

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
    expect(moodOf(overrides)).toEqual({ ...CALM_MOOD, state: "unknown", reason: "noPrice" });
  });

  it("shows no profit band or glow while another position has no fresh mark", () => {
    const mood = moodOf({
      positions: two,
      marks: { "A-PERP": freshMark("100.9"), "B-PERP": null },
      triggers: { "A-PERP": { takeProfit: armed("101", true) } },
    });
    expect(mood).toMatchObject({
      state: "unknown",
      reason: "noPrice",
      tone: null,
      intensity: 0,
      progress: 0,
      focus: null,
    });
  });

  it("shows no profit glow while the account exposure is unreadable", () => {
    const mood = moodOf({
      exposureUnreadable: true,
      marks: { "A-PERP": freshMark("100.9") },
      triggers: { "A-PERP": { takeProfit: armed("101", true) } },
    });
    expect(mood).toEqual({ ...CALM_MOOD, state: "unknown", reason: "accountUnreadable" });
  });

  it("keeps a calm danger glow that has begun while the picture is incomplete", () => {
    const mood = moodOf({
      positions: two,
      marks: { "A-PERP": freshMark("99.5"), "B-PERP": null },
      triggers: { "A-PERP": { stopLoss: armed("98", true) } },
    });
    expect(mood).toMatchObject({
      state: "unknown",
      reason: "noPrice",
      tone: "danger",
      focus: { market: "A-PERP", price: "98", kind: "stopLoss" },
    });
    expect(mood.intensity).toBeCloseTo(0.0625, 6);
  });

  it("still shows a known danger band while another position has no fresh mark", () => {
    expect(
      moodOf({
        positions: two,
        marks: { "A-PERP": freshMark("98.5"), "B-PERP": null },
        triggers: { "A-PERP": { stopLoss: armed("98", true) } },
      }).state,
    ).toBe("nearDanger");
  });

  it("carries no glow when nothing could be read", () => {
    expect(moodOf({ marks: { "A-PERP": null } })).toEqual({
      ...CALM_MOOD,
      state: "unknown",
      reason: "noPrice",
    });
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

  it("is untoned at the entry price", () => {
    expect(
      moodOf({ positions: [long], collateral: "1", marks: { "A-PERP": freshMark("0.1") } }),
    ).toEqual(CALM_MOOD);
  });

  it("warns a long as the mark falls towards the account's liquidation price", () => {
    const mood = moodOf({
      positions: [long],
      collateral: "1",
      marks: { "A-PERP": freshMark("0.0975") },
    });
    expect(mood).toMatchObject({ tone: "danger", reason: "liquidation" });
    expect(mood.progress).toBeGreaterThan(0);
  });

  it("warns a short as the mark rises towards it", () => {
    const mood = moodOf({
      positions: [short],
      collateral: "1",
      marks: { "A-PERP": freshMark("0.1025") },
    });
    expect(mood).toMatchObject({ tone: "danger", reason: "liquidation" });
    expect(mood.progress).toBeGreaterThan(0);
  });

  it("has no liquidation target without the account's collateral", () => {
    expect(
      moodOf({ positions: [long], collateral: null, marks: { "A-PERP": freshMark("0.09") } }),
    ).toEqual(CALM_MOOD);
  });

  it("is at danger once the mark is past the entry estimate", () => {
    const estimate = (candidate: Position) => (Number(candidate.size) > 0 ? "90" : "110");
    expect(
      moodOf({ entryLiquidation: estimate, marks: { "A-PERP": freshMark("89") } }),
    ).toMatchObject({ state: "atDanger", reason: "liquidation", intensity: 1 });
    expect(
      moodOf({
        positions: [position("A-PERP", "-1")],
        entryLiquidation: estimate,
        marks: { "A-PERP": freshMark("111") },
      }),
    ).toMatchObject({ state: "atDanger", reason: "liquidation", intensity: 1 });
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

describe("band hysteresis", () => {
  const raw = (overrides: Partial<RawMood>): RawMood => ({
    unknown: null,
    danger: null,
    profit: null,
    ...overrides,
  });
  const danger = (progress: number): RawMood =>
    raw({
      danger: {
        progress,
        bps: (1 - progress) * 300,
        reached: false,
        reason: "stopLoss",
        market: "A-PERP",
        price: "98",
      },
    });
  const profit = (progress: number): RawMood =>
    raw({
      profit: {
        progress,
        bps: (1 - progress) * 500,
        reached: false,
        market: "A-PERP",
        price: "104",
      },
    });
  const inDanger = nextMood(CALM_MOOD, danger(0.6));
  const inProfit = nextMood(CALM_MOOD, profit(0.6));

  it.each<[string, Mood, RawMood, string]>([
    ["enters danger at half way", CALM_MOOD, danger(0.5), "nearDanger"],
    ["does not enter danger just below half way", CALM_MOOD, danger(0.499), "calm"],
    ["stays in danger down to 0.45", inDanger, danger(0.45), "nearDanger"],
    ["leaves danger below 0.45", inDanger, danger(0.449), "calm"],
    ["enters profit at half way", CALM_MOOD, profit(0.5), "nearProfit"],
    ["does not enter profit just below half way", CALM_MOOD, profit(0.499), "calm"],
    ["stays in profit down to 0.45", inProfit, profit(0.45), "nearProfit"],
    ["leaves profit below 0.45", inProfit, profit(0.449), "calm"],
  ])("%s", (_name, from, reading, expected) => {
    expect(nextMood(from, reading).state).toBe(expected);
  });

  it("keeps the glow while the band is held below half way", () => {
    expect(nextMood(inDanger, danger(0.47))).toMatchObject({
      state: "nearDanger",
      tone: "danger",
    });
  });

  it("switches to at-danger at once on crossing, even from calm", () => {
    expect(
      nextMood(
        CALM_MOOD,
        raw({
          danger: {
            progress: 1,
            bps: 0,
            reached: true,
            reason: "liquidation",
            market: "A-PERP",
            price: null,
          },
        }),
      ),
    ).toMatchObject({ state: "atDanger", intensity: 1, progress: 1 });
  });

  it("does not carry a held danger band over to another position", () => {
    const other = danger(0.47);
    other.danger = { ...other.danger!, market: "B-PERP", price: "50" };
    expect(nextMood(inDanger, other)).toMatchObject({
      state: "calm",
      tone: "danger",
      focus: { market: "B-PERP" },
    });
  });

  it("does not carry a held danger band over to another target on the same position", () => {
    const liquidation = danger(0.47);
    liquidation.danger = { ...liquidation.danger!, reason: "liquidation", price: "90" };
    expect(nextMood(inDanger, liquidation).state).toBe("calm");
  });

  it("does not carry a held profit band over to another position", () => {
    const other = profit(0.47);
    other.profit = { ...other.profit!, market: "B-PERP", price: "60" };
    expect(nextMood(inProfit, other).state).toBe("calm");
  });

  it("does not hold a danger band across a different state", () => {
    const unknownBand = nextMood(inDanger, raw({ unknown: "noPrice" }));
    expect(unknownBand).toMatchObject({ state: "unknown", reason: "noPrice", tone: null });
    expect(nextMood(unknownBand, danger(0.47)).state).toBe("calm");
  });

  it("compares every field when deciding two moods are the same", () => {
    const base = nextMood(CALM_MOOD, danger(0.6));
    expect(sameMood(base, nextMood(CALM_MOOD, danger(0.6)))).toBe(true);
    expect(sameMood(base, nextMood(CALM_MOOD, danger(0.61)))).toBe(false);
    const focus = { market: "A-PERP", price: "98", kind: "stopLoss" } as const;
    expect(sameMood(base, { ...base, focus: { ...focus, market: "B-PERP" } })).toBe(false);
    expect(sameMood(base, { ...base, focus: { ...focus, price: null } })).toBe(false);
    expect(sameMood(base, { ...base, focus: { ...focus, kind: "liquidation" } })).toBe(false);
    expect(sameMood(base, { ...base, focus: null })).toBe(false);
    expect(sameMood(base, { ...base, tone: "profit" })).toBe(false);
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

  it("follows the position furthest towards its danger, with that position's own take profit", () => {
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

  it("follows the same position as the mood when progress differs from distance", () => {
    const overrides = {
      positions: [position("A-PERP", "1", "100"), position("B-PERP", "1", "50")],
      marks: { "A-PERP": freshMark("99"), "B-PERP": freshMark("47") },
      triggers: {
        "A-PERP": { stopLoss: armed("98", true) },
        "B-PERP": { stopLoss: armed("46", true) },
      },
    };
    const gauge = positionGauge(input(overrides));
    expect(gauge?.dangerBps).toBeCloseTo((1 / 47) * 10_000, 1);
  });

  it("follows the position the mood focuses on, not another one's danger reading", () => {
    const overrides = {
      positions: [position("A-PERP", "1"), position("B-PERP", "1")],
      marks: { "A-PERP": freshMark("100"), "B-PERP": freshMark("101") },
      triggers: {
        "A-PERP": { stopLoss: armed("98", true), takeProfit: armed("102", true) },
        "B-PERP": { takeProfit: armed("102", true) },
      },
    };
    const mood = nextMood(CALM_MOOD, rawMood(input(overrides)));
    expect(mood).toMatchObject({
      state: "nearProfit",
      reason: "takeProfit",
      tone: "profit",
      focus: { market: "B-PERP", price: "102", kind: "takeProfit" },
    });
    const gauge = positionGauge(input(overrides), mood.focus?.market ?? null);
    expect(gauge?.dangerBps).toBeNull();
    expect(gauge?.dangerReason).toBeNull();
    expect(gauge?.profitBps).toBeCloseTo((1 / 101) * 10_000, 1);
  });

  it("shows the focused position's own danger reading and take profit", () => {
    const gauge = positionGauge(
      input({
        positions: [position("A-PERP", "1"), position("B-PERP", "1")],
        marks: { "A-PERP": freshMark("99"), "B-PERP": freshMark("100") },
        triggers: {
          "A-PERP": { stopLoss: armed("98", true), takeProfit: armed("101", true) },
          "B-PERP": { stopLoss: armed("99", true), takeProfit: armed("110", true) },
        },
      }),
      "B-PERP",
    );
    expect(gauge).toEqual({ dangerBps: 100, dangerReason: "stopLoss", profitBps: 1000 });
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
