import { isStale, STALE_MARK_MS } from "@/lib/market-data/selectors";
import { fromFixedPoint, toFixedPoint } from "./decimal";
import { positionRisks, unknownPositionRisks } from "./positionRisk";
import type { Position, TriggerKind } from "./types";

/**
 * How close the open perpetual positions are to their stop loss (or, with no
 * stop loss, their estimated liquidation) and take profit, as one small value
 * the Fun mode visuals read. It is a display of distance only: nothing here
 * places, changes or advises on an order.
 */
const NEAR_ENTER = 0.5;
const NEAR_LEAVE = 0.45;

/** Distance windows used only when progress from the entry price cannot be measured. */
const DANGER_FALLBACK_BPS = 300;
const PROFIT_FALLBACK_BPS = 500;

const BPS = 10_000n;
const BPS_RESOLUTION = 100n;
const PROGRESS_RESOLUTION = 1_000_000n;

export type MoodState = "calm" | "nearProfit" | "atProfit" | "nearDanger" | "atDanger" | "unknown";

export type MoodReason =
  | "liquidation"
  | "stopLoss"
  | "takeProfit"
  /** Unknown state only: an open position has no fresh price. */
  | "noPrice"
  /** Unknown state only: the account holds exposure this terminal cannot read. */
  | "accountUnreadable";

export type MoodTone = "danger" | "profit";

export interface Mood {
  /** The wizard's band; it keeps hysteresis and can stay calm while the glow already shows. */
  state: MoodState;
  /** The band's reason, or the toned target's reason while the band is calm. */
  reason: MoodReason | null;
  /** Which target the glow follows: the band's target when there is a band, else danger once it has begun to close, else profit. */
  tone: MoodTone | null;
  /** 0..1, continuous: the square of progress. */
  intensity: number;
  /** 0..1 linear, from break-even to the target the tone follows. */
  progress: number;
  /** The position and target the tone follows; price is null when liquidation is already reached. */
  focus: { market: string; price: string | null; kind: MoodTarget } | null;
}

/** What kind of target the tone follows. */
export type MoodTarget = "stopLoss" | "liquidation" | "takeProfit";

export const CALM_MOOD: Mood = {
  state: "calm",
  reason: null,
  tone: null,
  intensity: 0,
  progress: 0,
  focus: null,
};

export interface DangerReading {
  /** 0..1 from break-even to the danger target; 1 once the target is reached. */
  progress: number;
  /** Basis points of the mark left before the target; zero or less means reached. */
  bps: number;
  reached: boolean;
  reason: "liquidation" | "stopLoss";
  market: string;
  price: string | null;
}

export interface ProfitReading {
  progress: number;
  bps: number;
  reached: boolean;
  market: string;
  price: string;
}

/** The danger and profit reading of the position furthest along each. */
export interface RawMood {
  /** Why the picture is incomplete: an open position has no fresh mark, or the account holds exposure this terminal cannot read. */
  unknown: "noPrice" | "accountUnreadable" | null;
  danger: DangerReading | null;
  profit: ProfitReading | null;
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

export function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function plainPrice(price: bigint): string {
  const text = fromFixedPoint(price, 9);
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
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

interface Measured {
  progress: number;
  bps: number;
  reached: boolean;
}

/**
 * How far the mark has travelled from the entry price (break-even) to the
 * target, 0..1. Falls back to a distance window when the entry is unknown or
 * the target is not on the far side of it.
 */
function measure(
  entry: bigint | null,
  mark: bigint,
  target: bigint,
  side: 1n | -1n,
  danger: boolean,
): Measured {
  const bps = bpsAway(mark, target, side, !danger);
  if (bps <= 0) return { progress: 1, bps, reached: true };
  if (entry !== null) {
    const direction = danger ? -side : side;
    const span = direction * (target - entry);
    if (span > 0n) {
      const travelled = direction * (mark - entry);
      const progress = clamp01(Number((travelled * PROGRESS_RESOLUTION) / span) / 1_000_000);
      return { progress, bps, reached: false };
    }
  }
  const window = danger ? DANGER_FALLBACK_BPS : PROFIT_FALLBACK_BPS;
  return { progress: clamp01(1 - bps / window), bps, reached: false };
}

interface PositionReading {
  danger: DangerReading | null;
  profit: ProfitReading | null;
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
    const parsedEntry = parseFixed(position.entryPrice);
    const entry = parsedEntry !== null && parsedEntry > 0n ? parsedEntry : null;

    const usable = (kind: TriggerKind): { text: string; price: bigint } | null => {
      const reading = input.trigger(position.market, kind);
      if (!reading || !reading.armed || reading.long !== long) return null;
      const price = parseFixed(reading.price);
      return price !== null && price > 0n ? { text: reading.price, price } : null;
    };

    const liquidation = risks
      ? risks.get(position.market)?.liquidation
      : entryLiquidationOf(input, position);
    const stopLoss = usable("stopLoss");

    const liquidationFirst =
      liquidation?.kind === "now" ||
      (liquidation?.kind === "price" &&
        stopLoss !== null &&
        (long ? liquidation.price >= stopLoss.price : liquidation.price <= stopLoss.price));

    let danger: DangerReading | null = null;
    if (liquidation && (liquidationFirst || (stopLoss === null && liquidation.kind === "price"))) {
      if (liquidation.kind === "now") {
        danger = {
          progress: 1,
          bps: 0,
          reached: true,
          reason: "liquidation",
          market: position.market,
          price: null,
        };
      } else if (liquidation.kind === "price") {
        danger = {
          ...measure(entry, mark, liquidation.price, side, true),
          reason: "liquidation",
          market: position.market,
          price: plainPrice(liquidation.price),
        };
      }
    } else if (stopLoss !== null) {
      danger = {
        ...measure(entry, mark, stopLoss.price, side, true),
        reason: "stopLoss",
        market: position.market,
        price: stopLoss.text,
      };
    }

    const takeProfit = usable("takeProfit");
    const profit: ProfitReading | null =
      takeProfit === null
        ? null
        : {
            ...measure(entry, mark, takeProfit.price, side, false),
            market: position.market,
            price: takeProfit.text,
          };
    readings.push({ danger, profit });
  }
  return { unknown, readings };
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

/** The reading furthest along its target; nearer in distance breaks a tie. */
function furthest<T extends { progress: number; bps: number }>(current: T | null, next: T): T {
  if (current === null) return next;
  if (next.progress !== current.progress) return next.progress > current.progress ? next : current;
  return next.bps < current.bps ? next : current;
}

export function rawMood(input: MoodInput): RawMood {
  const { unknown, readings } = readPositions(input);
  let danger: DangerReading | null = null;
  let profit: ProfitReading | null = null;
  for (const reading of readings) {
    if (reading.danger) danger = furthest(danger, reading.danger);
    if (reading.profit) profit = furthest(profit, reading.profit);
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

/**
 * The risk range of the position furthest towards its danger target (or, when
 * none has one, towards its take profit), with that position's own take
 * profit. Null when there is nothing to draw. When the mood has a focus, the
 * bar follows the position on that market instead, so it matches the glow.
 */
export function positionGauge(input: MoodInput, focusMarket: string | null = null): Gauge | null {
  const { readings } = readPositions(input);
  const focused =
    focusMarket === null
      ? undefined
      : readings.find(
          (reading) =>
            reading.danger?.market === focusMarket || reading.profit?.market === focusMarket,
        );
  if (focused) {
    return {
      dangerBps: focused.danger?.bps ?? null,
      dangerReason: focused.danger?.reason ?? null,
      profitBps: focused.profit?.bps ?? null,
    };
  }
  const withDanger = readings.filter((reading) => reading.danger !== null);
  if (withDanger.length > 0) {
    const chosen = withDanger.reduce((best, item) =>
      furthest(best.danger, item.danger!) === item.danger ? item : best,
    );
    return {
      dangerBps: chosen.danger!.bps,
      dangerReason: chosen.danger!.reason,
      profitBps: chosen.profit?.bps ?? null,
    };
  }
  const withProfit = readings.filter((reading) => reading.profit !== null);
  if (withProfit.length === 0) return null;
  const chosen = withProfit.reduce((best, item) =>
    furthest(best.profit, item.profit!) === item.profit ? item : best,
  );
  return { dangerBps: null, dangerReason: null, profitBps: chosen.profit!.bps };
}

/** Where the mark sits between the danger end (0) and the take-profit end (1). Null when neither end is known. */
export function gaugeMarker(gauge: Gauge): number | null {
  const danger = gauge.dangerBps === null ? null : Math.max(gauge.dangerBps, 0);
  const profit = gauge.profitBps === null ? null : Math.max(gauge.profitBps, 0);
  if (danger !== null && profit !== null) {
    return danger + profit === 0 ? 0 : clamp01(danger / (danger + profit));
  }
  if (danger !== null) return clamp01(danger / GAUGE_ROOM_BPS);
  if (profit !== null) return clamp01(1 - profit / GAUGE_ROOM_BPS);
  return null;
}

const DANGER_STATES: readonly MoodState[] = ["nearDanger", "atDanger"];
const PROFIT_STATES: readonly MoodState[] = ["nearProfit", "atProfit"];

/** Whether the band shown before belongs to this same position and target, so it may be held below half way. */
function heldFor(
  previous: Mood,
  states: readonly MoodState[],
  market: string,
  kind: MoodTarget,
): boolean {
  return (
    states.includes(previous.state) &&
    previous.focus?.market === market &&
    previous.focus.kind === kind
  );
}

/** The wizard's band for one end: reached at once, near from half way, held until a little below it. */
function bandOf(
  reading: { progress: number; reached: boolean },
  held: boolean,
): "at" | "near" | null {
  if (reading.reached) return "at";
  if (reading.progress >= NEAR_ENTER || (held && reading.progress >= NEAR_LEAVE)) return "near";
  return null;
}

/**
 * Which target the glow follows. A band decides it: danger first, then profit
 * (never while the picture is incomplete). With no band, a danger that has
 * begun wins over a profit that has begun, and an incomplete picture shows no
 * profit glow.
 */
function toneOf(raw: RawMood, dangerBand: boolean, profitBand: boolean): MoodTone | null {
  if (dangerBand) return "danger";
  if (profitBand) return "profit";
  if (raw.danger !== null && raw.danger.progress > 0) return "danger";
  if (!raw.unknown && raw.profit !== null && raw.profit.progress > 0) return "profit";
  return null;
}

/**
 * The mood to show, given the one shown before it. The glow (tone, intensity,
 * progress) follows the readings continuously. The wizard's band is entered at
 * half way to the target and only left a little below it, so a mark hovering at
 * the edge does not make the wizard flicker; reaching a target switches at once.
 */
export function nextMood(previous: Mood, raw: RawMood): Mood {
  const dangerBand = raw.danger
    ? bandOf(raw.danger, heldFor(previous, DANGER_STATES, raw.danger.market, raw.danger.reason))
    : null;
  const profitBand =
    raw.profit && !raw.unknown
      ? bandOf(raw.profit, heldFor(previous, PROFIT_STATES, raw.profit.market, "takeProfit"))
      : null;

  const tone = toneOf(raw, dangerBand !== null, profitBand !== null);
  const toned = tone === "danger" ? raw.danger : tone === "profit" ? raw.profit : null;
  const glow = toned
    ? {
        tone,
        intensity: toned.progress * toned.progress,
        progress: toned.progress,
        focus: {
          market: toned.market,
          price: toned.price,
          kind: tone === "danger" ? raw.danger!.reason : ("takeProfit" as const),
        },
      }
    : { tone: null, intensity: 0, progress: 0, focus: null };
  const tonedReason: MoodReason | null =
    tone === "danger" ? raw.danger!.reason : tone === "profit" ? "takeProfit" : null;

  if (raw.danger && dangerBand) {
    return {
      ...glow,
      state: dangerBand === "at" ? "atDanger" : "nearDanger",
      reason: raw.danger.reason,
    };
  }
  if (raw.unknown) return { ...glow, state: "unknown", reason: raw.unknown };

  if (profitBand) {
    return {
      ...glow,
      state: profitBand === "at" ? "atProfit" : "nearProfit",
      reason: "takeProfit",
    };
  }
  return { ...glow, state: "calm", reason: tonedReason };
}

export function sameMood(a: Mood, b: Mood): boolean {
  return (
    a.state === b.state &&
    a.reason === b.reason &&
    a.tone === b.tone &&
    a.intensity === b.intensity &&
    a.progress === b.progress &&
    a.focus?.market === b.focus?.market &&
    a.focus?.price === b.focus?.price &&
    a.focus?.kind === b.focus?.kind &&
    (a.focus === null) === (b.focus === null)
  );
}
