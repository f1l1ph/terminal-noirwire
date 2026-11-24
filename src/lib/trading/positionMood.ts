import { isStale, STALE_MARK_MS } from "@/lib/market-data/selectors";
import { toFixedPoint } from "./decimal";
import { positionRisks, unknownPositionRisks } from "./positionRisk";
import type { Position, TriggerKind } from "./types";

/**
 * How close the open perpetual positions are to their estimated liquidation,
 * stop loss and take profit, as one small value the Fun mode visuals read.
 * It is a display of distance only: nothing here places, changes or
 * advises on an order.
 */
export const DANGER_ENTER_BPS = 300;
export const DANGER_LEAVE_BPS = 360;
export const PROFIT_ENTER_BPS = 500;
export const PROFIT_LEAVE_BPS = 575;

const INTENSITY_STEPS = 10;
const BPS = 10_000n;
const BPS_RESOLUTION = 100n;

export type MoodState = "calm" | "nearProfit" | "atProfit" | "nearDanger" | "atDanger" | "unknown";

export type MoodReason =
  | "liquidation"
  | "stopLoss"
  | "takeProfit"
  /** Unknown state only: an open position has no fresh price. */
  | "noPrice"
  /** Unknown state only: the account holds exposure this terminal cannot read. */
  | "accountUnreadable";

export interface Mood {
  state: MoodState;
  /** 0..1 in tenths; never 0 while a state other than calm or unknown holds. */
  intensity: number;
  reason: MoodReason | null;
}

export const CALM_MOOD: Mood = { state: "calm", intensity: 0, reason: null };

/** The nearest target of each kind, in basis points of the mark; zero or less means the mark has reached it. */
export interface RawMood {
  /** Why the picture is incomplete: an open position has no fresh mark, or the account holds exposure this terminal cannot read. */
  unknown: "noPrice" | "accountUnreadable" | null;
  danger: { bps: number; reason: "liquidation" | "stopLoss" } | null;
  profit: { bps: number } | null;
}

export interface LocalTriggerReading {
  price: string;
  /** The direction of the position the trigger was set on. */
  long: boolean;
  /** The exchange reported this trigger as armed. */
  armed: boolean;
}

export interface MoodInput {
  positions: Position[];
  collateral: string | null;
  exposureUnreadable: boolean;
  marks: Record<string, { price: string; time: number } | null>;
  now: number;
  trigger: (market: string, kind: TriggerKind) => LocalTriggerReading | null;
  /**
   * The liquidation price the account panel shows for a position from its
   * entry alone. Used only while the account carries no collateral to
   * compute a liquidation from, so the tint follows the number on screen.
   */
  entryLiquidation: (position: Position) => string | null;
}

function parseFixed(value: string): bigint | null {
  try {
    return toFixedPoint(value);
  } catch {
    return null;
  }
}

/**
 * Basis points of the mark left before it reaches the target, in the
 * position's own direction (`side` is +1 for a long, -1 for a short), at 0.01
 * bp resolution. Zero or less means the target has been reached.
 */
function bpsAway(mark: bigint, target: bigint, side: 1n | -1n, towardsHigher: boolean): number {
  const gap = towardsHigher ? target - mark : mark - target;
  return Number((side * gap * BPS * BPS_RESOLUTION) / mark) / Number(BPS_RESOLUTION);
}

function entryLiquidationOf(
  input: MoodInput,
  position: Position,
): { kind: "price"; price: bigint } | null {
  if (input.exposureUnreadable) return null;
  const text = input.entryLiquidation(position);
  const price = text === null ? null : parseFixed(text);
  return price !== null && price > 0n ? { kind: "price", price } : null;
}

function nearest<T extends { bps: number }>(current: T | null, candidate: T): T {
  return current === null || candidate.bps < current.bps ? candidate : current;
}

interface PositionReading {
  danger: { bps: number; reason: "liquidation" | "stopLoss" } | null;
  profit: { bps: number } | null;
}

function readPositions(input: MoodInput): {
  unknown: RawMood["unknown"];
  readings: PositionReading[];
} {
  const open = input.positions.filter((position) => Number(position.size) !== 0);
  if (open.length === 0) return { unknown: null, readings: [] };

  const freshMark = (market: string): bigint | null => {
    const mark = input.marks[market];
    if (!mark || isStale(mark.time, input.now, STALE_MARK_MS)) return null;
    const price = parseFixed(mark.price);
    return price !== null && price > 0n ? price : null;
  };
  const markOf = (market: string): string | null => {
    const mark = input.marks[market];
    return freshMark(market) === null || !mark ? null : mark.price;
  };

  let unknown: RawMood["unknown"] = input.exposureUnreadable ? "accountUnreadable" : null;
  const risks = input.exposureUnreadable
    ? unknownPositionRisks(open)
    : positionRisks(open, input.collateral, markOf);

  const readings: PositionReading[] = [];

  for (const position of open) {
    const mark = freshMark(position.market);
    const size = parseFixed(position.size);
    if (mark === null || size === null) {
      unknown = "noPrice";
      continue;
    }
    const long = size > 0n;
    const side = long ? 1n : -1n;

    let danger: PositionReading["danger"] = null;
    let profit: PositionReading["profit"] = null;

    const liquidation = risks
      ? risks.get(position.market)?.liquidation
      : entryLiquidationOf(input, position);
    if (liquidation?.kind === "now") {
      danger = nearest(danger, { bps: 0, reason: "liquidation" as const });
    } else if (liquidation?.kind === "price") {
      danger = nearest(danger, {
        bps: bpsAway(mark, liquidation.price, side, false),
        reason: "liquidation" as const,
      });
    }

    const usable = (kind: TriggerKind): bigint | null => {
      const reading = input.trigger(position.market, kind);
      if (!reading || !reading.armed || reading.long !== long) return null;
      const price = parseFixed(reading.price);
      return price !== null && price > 0n ? price : null;
    };

    const stopLoss = usable("stopLoss");
    if (stopLoss !== null) {
      danger = nearest(danger, {
        bps: bpsAway(mark, stopLoss, side, false),
        reason: "stopLoss" as const,
      });
    }
    const takeProfit = usable("takeProfit");
    if (takeProfit !== null) {
      profit = { bps: bpsAway(mark, takeProfit, side, true) };
    }
    readings.push({ danger, profit });
  }
  return { unknown, readings };
}

export function rawMood(input: MoodInput): RawMood {
  const { unknown, readings } = readPositions(input);
  let danger: RawMood["danger"] = null;
  let profit: RawMood["profit"] = null;
  for (const reading of readings) {
    if (reading.danger) danger = nearest(danger, reading.danger);
    if (reading.profit) profit = nearest(profit, reading.profit);
  }
  return { unknown, danger, profit };
}

/** Basis points of room that fill the whole risk bar when only one end is known. */
export const GAUGE_ROOM_BPS = 1000;

/** The distance to each end of one position's risk range, for the bar under the wizard's line. */
export interface Gauge {
  dangerBps: number | null;
  dangerReason: "liquidation" | "stopLoss" | null;
  profitBps: number | null;
}

function lowest<T>(items: T[], bpsOf: (item: T) => number): T {
  return items.reduce((best, item) => (bpsOf(item) < bpsOf(best) ? item : best));
}

/**
 * The risk range of the position nearest its danger target (or, when none has
 * one, nearest its take profit), with that position's own take profit. Null
 * when there is nothing to draw.
 */
export function positionGauge(input: MoodInput): Gauge | null {
  const { readings } = readPositions(input);
  const withDanger = readings.filter((reading) => reading.danger !== null);
  if (withDanger.length > 0) {
    const chosen = lowest(withDanger, (reading) => reading.danger!.bps);
    return {
      dangerBps: chosen.danger!.bps,
      dangerReason: chosen.danger!.reason,
      profitBps: chosen.profit?.bps ?? null,
    };
  }
  const withProfit = readings.filter((reading) => reading.profit !== null);
  if (withProfit.length === 0) return null;
  const chosen = lowest(withProfit, (reading) => reading.profit!.bps);
  return { dangerBps: null, dangerReason: null, profitBps: chosen.profit!.bps };
}

/** Where the mark sits between the danger end (0) and the take-profit end (1). Null when neither end is known. */
export function gaugeMarker(gauge: Gauge): number | null {
  const clamp = (value: number) => Math.min(Math.max(value, 0), 1);
  const danger = gauge.dangerBps === null ? null : Math.max(gauge.dangerBps, 0);
  const profit = gauge.profitBps === null ? null : Math.max(gauge.profitBps, 0);
  if (danger !== null && profit !== null) {
    return danger + profit === 0 ? 0 : clamp(danger / (danger + profit));
  }
  if (danger !== null) return clamp(danger / GAUGE_ROOM_BPS);
  if (profit !== null) return clamp(1 - profit / GAUGE_ROOM_BPS);
  return null;
}

function quantize(score: number): number {
  const steps = Math.round(Math.min(Math.max(score, 0), 1) * INTENSITY_STEPS);
  return Math.max(steps, 1) / INTENSITY_STEPS;
}

function intensityAt(bps: number, window: number): number {
  return quantize(1 - Math.max(bps, 0) / window);
}

/**
 * The mood to show, given the one shown before it. A band is entered at its
 * window and only left a little beyond it, so a mark hovering at the edge
 * does not make the screen flicker; reaching a target or an account already
 * below maintenance switches at once.
 */
export function nextMood(previous: Mood, raw: RawMood): Mood {
  const wasDanger = previous.state === "nearDanger" || previous.state === "atDanger";
  if (raw.danger !== null) {
    const { bps, reason } = raw.danger;
    if (bps <= 0) return { state: "atDanger", intensity: 1, reason };
    if (bps <= DANGER_ENTER_BPS || (wasDanger && bps <= DANGER_LEAVE_BPS)) {
      return { state: "nearDanger", intensity: intensityAt(bps, DANGER_ENTER_BPS), reason };
    }
  }
  if (raw.unknown) return { state: "unknown", intensity: 0, reason: raw.unknown };

  const wasProfit = previous.state === "nearProfit" || previous.state === "atProfit";
  if (raw.profit !== null) {
    const { bps } = raw.profit;
    if (bps <= 0) return { state: "atProfit", intensity: 1, reason: "takeProfit" };
    if (bps <= PROFIT_ENTER_BPS || (wasProfit && bps <= PROFIT_LEAVE_BPS)) {
      return {
        state: "nearProfit",
        intensity: intensityAt(bps, PROFIT_ENTER_BPS),
        reason: "takeProfit",
      };
    }
  }
  return CALM_MOOD;
}

export function sameMood(a: Mood, b: Mood): boolean {
  return a.state === b.state && a.intensity === b.intensity && a.reason === b.reason;
}
