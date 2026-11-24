import { fromFixedPoint, mulFixedPoint, toFixedPoint } from "./decimal";
import { DEFAULT_SLIPPAGE_BPS } from "./marketBound";
import type { LocalTrigger, LocalTriggers } from "./triggerStore";
import type { TriggerChainState, TriggerKind } from "./types";
import { MAX_LIMIT_PRICE_DEVIATION_BPS } from "./validation";

/** The slippage a new trigger starts with: the same distance a market order's worst price sits from the mark by default. */
export const DEFAULT_TRIGGER_SLIPPAGE_BPS = DEFAULT_SLIPPAGE_BPS;

export const TRIGGER_KINDS: readonly TriggerKind[] = ["takeProfit", "stopLoss"];

export const TRIGGER_NAME: Record<TriggerKind, string> = {
  takeProfit: "Take profit",
  stopLoss: "Stop loss",
};

export const TRIGGER_SHORT: Record<TriggerKind, string> = {
  takeProfit: "TP",
  stopLoss: "SL",
};

const BPS = 10_000n;

export function positionIsLong(signedSize: string): boolean {
  return !signedSize.trim().startsWith("-");
}

function floorToTick(value: bigint, tick: bigint): bigint {
  return tick > 0n ? value - (value % tick) : value;
}

function roundToTick(value: bigint, tick: bigint): bigint {
  if (tick <= 0n) return value;
  const floored = floorToTick(value, tick);
  return (value - floored) * 2n >= tick ? floored + tick : floored;
}

function ceilToTick(value: bigint, tick: bigint): bigint {
  const floored = floorToTick(value, tick);
  return floored === value ? value : floored + tick;
}

function parseFixed(text: string): bigint | null {
  try {
    return toFixedPoint(text);
  } catch {
    return null;
  }
}

/** How far `price` sits from `mark`, in basis points, signed and cut toward zero; null when either cannot be read or the mark is not positive. */
export function bpsFromMark(price: string, mark: string): number | null {
  const priceValue = parseFixed(price);
  const markValue = parseFixed(mark);
  if (priceValue === null || markValue === null || markValue <= 0n) return null;
  return Number(((priceValue - markValue) * BPS) / markValue);
}

/** "+4.20%" or "-1.50%" for a distance in basis points. */
export function formatBpsFromMark(bps: number): string {
  const percent = (bps / 100).toFixed(2);
  return bps > 0 ? `+${percent}%` : `${percent}%`;
}

/** The price `bps` basis points from `mark`, rounded to the nearest tick. */
export function priceFromBps(
  bps: number,
  mark: string,
  tick: string,
  priceDecimals: number,
): string | null {
  const markValue = parseFixed(mark);
  const tickValue = parseFixed(tick);
  if (markValue === null || tickValue === null || markValue <= 0n) return null;
  const moved = (markValue * (BPS + BigInt(Math.round(bps)))) / BPS;
  if (moved <= 0n) return null;
  return fromFixedPoint(roundToTick(moved, tickValue), priceDecimals);
}

/**
 * What closing `size` at `price` adds to the account, against the position's
 * entry (its break-even price), before fees and funding. A fixed-point
 * amount in the quote token; null when a figure cannot be read.
 */
export function estimatedPnl(params: {
  long: boolean;
  entry: string;
  price: string;
  size: string;
}): bigint | null {
  const entry = parseFixed(params.entry);
  const price = parseFixed(params.price);
  const size = parseFixed(params.size);
  if (entry === null || price === null || size === null || size < 0n) return null;
  return mulFixedPoint(params.long ? price - entry : entry - price, size);
}

/** The worst price the closing market order may fill at: `slippageBps` past the trigger price, on the tick, away from it. */
export function worstPriceFor(params: {
  triggerPrice: string;
  long: boolean;
  slippageBps: number;
  tick: string;
  priceDecimals: number;
}): string | null {
  const trigger = parseFixed(params.triggerPrice);
  const tick = parseFixed(params.tick);
  if (trigger === null || tick === null || trigger <= 0n) return null;
  const slippage = BigInt(Math.round(params.slippageBps));
  if (params.long) {
    const worst = floorToTick((trigger * (BPS - slippage)) / BPS, tick);
    return worst > 0n ? fromFixedPoint(worst, params.priceDecimals) : null;
  }
  return fromFixedPoint(ceilToTick((trigger * (BPS + slippage)) / BPS, tick), params.priceDecimals);
}

/** Percent text ("1", "0.5") to whole basis points; null when it is not a number above zero. */
export function slippageBpsFromPercent(text: string): number | null {
  const value = parseFixed(text);
  if (value === null || value <= 0n) return null;
  const bps = Number((value * 100n) / 1_000_000_000n);
  return bps > 0 ? bps : null;
}

export function percentFromBps(bps: number): string {
  return String(bps / 100);
}

export type TriggerFieldError =
  | "priceNotANumber"
  | "priceNotOnTick"
  | "priceWrongSide"
  | "markUnavailable"
  | "sizeRequired"
  | "sizeNotOnLot"
  | "sizeBelowMinimum"
  | "sizeAbovePosition"
  | "slippageInvalid"
  | "slippageTooWide";

export interface TriggerDraft {
  takeProfit: string;
  stopLoss: string;
  /** Close the whole position when it fires, rather than `size`. */
  whole: boolean;
  size: string;
  slippagePercent: string;
}

export interface TriggerMarketContext {
  long: boolean;
  /** The fresh mark; null when there is none. */
  mark: string | null;
  tick: string;
  lot: string;
  /** The position's size without its sign. */
  positionSize: string;
  minSize?: string;
  bandBps?: number;
}

export type TriggerErrors = Partial<
  Record<"takeProfit" | "stopLoss" | "size" | "slippage", TriggerFieldError>
>;

/** The widest slippage a trigger may carry: the market's crossing band when it is known, the same limit an order's price has otherwise. */
export function maxSlippageBps(bandBps: number | undefined): number {
  return bandBps ?? MAX_LIMIT_PRICE_DEVIATION_BPS;
}

function priceError(
  kind: TriggerKind,
  text: string,
  context: TriggerMarketContext,
): TriggerFieldError | null {
  const value = parseFixed(text);
  if (value === null || value <= 0n) return "priceNotANumber";
  const tick = parseFixed(context.tick);
  if (tick !== null && tick > 0n && value % tick !== 0n) return "priceNotOnTick";
  const mark = context.mark === null ? null : parseFixed(context.mark);
  if (mark === null || mark <= 0n) return "markUnavailable";
  const above = kind === "takeProfit" ? context.long : !context.long;
  return above ? (value > mark ? null : "priceWrongSide") : value < mark ? null : "priceWrongSide";
}

function sizeError(draft: TriggerDraft, context: TriggerMarketContext): TriggerFieldError | null {
  if (draft.whole) return null;
  const size = parseFixed(draft.size);
  if (size === null || size <= 0n) return "sizeRequired";
  const lot = parseFixed(context.lot);
  if (lot !== null && lot > 0n && size % lot !== 0n) return "sizeNotOnLot";
  const minimum = context.minSize === undefined ? null : parseFixed(context.minSize);
  if (minimum !== null && size < minimum) return "sizeBelowMinimum";
  const held = parseFixed(context.positionSize);
  if (held !== null && size > held) return "sizeAbovePosition";
  return null;
}

/** Checks a draft against the position and market it is for; a price field left empty is simply not set. */
export function validateTriggerDraft(
  draft: TriggerDraft,
  context: TriggerMarketContext,
): TriggerErrors {
  const errors: TriggerErrors = {};
  for (const kind of TRIGGER_KINDS) {
    const text = draft[kind].trim();
    if (!text) continue;
    const error = priceError(kind, text, context);
    if (error) errors[kind] = error;
  }
  const size = sizeError(draft, context);
  if (size) errors.size = size;
  const slippage = slippageBpsFromPercent(draft.slippagePercent);
  if (slippage === null) errors.slippage = "slippageInvalid";
  else if (slippage > maxSlippageBps(context.bandBps)) errors.slippage = "slippageTooWide";
  return errors;
}

export function describeTriggerError(
  error: TriggerFieldError,
  kind: TriggerKind | null,
  context: TriggerMarketContext & { base: string; quote: string },
): string {
  switch (error) {
    case "priceNotANumber":
      return "Enter a price above zero.";
    case "priceNotOnTick":
      return `Use a price in steps of ${plainNumber(context.tick)}.`;
    case "markUnavailable":
      return "There is no fresh mark price right now. Try again in a moment.";
    case "priceWrongSide": {
      const above = kind === "takeProfit" ? context.long : !context.long;
      const name = kind === "takeProfit" ? "take profit" : "stop loss";
      return `A ${name} on a ${context.long ? "long" : "short"} has to sit ${above ? "above" : "below"} the mark price.`;
    }
    case "sizeRequired":
      return `Enter an amount in ${context.base}.`;
    case "sizeNotOnLot":
      return `Use increments of ${plainNumber(context.lot)} ${context.base}.`;
    case "sizeBelowMinimum":
      return `The smallest size is ${plainNumber(context.minSize ?? context.lot)} ${context.base}.`;
    case "sizeAbovePosition":
      return "That is more than your position.";
    case "slippageInvalid":
      return "Enter slippage above 0%.";
    case "slippageTooWide":
      return `Slippage can be at most ${maxSlippageBps(context.bandBps) / 100}%.`;
  }
}

function plainNumber(text: string): string {
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

export interface TriggerChange {
  op: "set" | "cancel";
  kind: TriggerKind;
}

/**
 * What saving the editor has to send. A trigger is removed when its Remove
 * was pressed, or when a price this device had set is cleared. A price filled
 * in sets it when it is new, changed, or when the size or slippage it shares
 * with the other one changed. Nothing is sent for a field left as it was: an
 * empty field beside a trigger set from another device removes nothing.
 */
export function planTriggerChanges(params: {
  draft: TriggerDraft;
  initial: TriggerDraft;
  exists: Record<TriggerKind, boolean>;
  remove: Record<TriggerKind, boolean>;
}): TriggerChange[] {
  const { draft, initial, exists, remove } = params;
  const sharedChanged =
    draft.whole !== initial.whole ||
    (!draft.whole && draft.size.trim() !== initial.size.trim()) ||
    draft.slippagePercent.trim() !== initial.slippagePercent.trim();
  const cancels: TriggerChange[] = [];
  const sets: TriggerChange[] = [];
  for (const kind of TRIGGER_KINDS) {
    const price = draft[kind].trim();
    if (remove[kind] || (!price && initial[kind].trim())) {
      if (exists[kind]) cancels.push({ op: "cancel", kind });
    } else if (!price) {
      continue;
    } else if (!exists[kind] || price !== initial[kind].trim() || sharedChanged) {
      sets.push({ op: "set", kind });
    }
  }
  return [...cancels, ...sets];
}

export type TriggerTone = "ok" | "warn" | "muted";

export interface TriggerLine {
  kind: TriggerKind;
  /** The price this device remembers setting, or null when it has no record (set elsewhere). The exchange keeps the price sealed. */
  price: string | null;
  /** When this device set the remembered price. */
  setAtMs: number | null;
  status: string;
  tone: TriggerTone;
  /** A second sentence: when the next attempt comes. */
  detail: string | null;
}

export const UNFILLABLE_STATUS = "Cannot close at this size";

/**
 * What to say about one trigger. `chain` is what the exchange last reported
 * (null before it has been read), `local` what this device remembers setting.
 * A `stale` read is as of `readAtMs`, never shown as live. Null means there is
 * nothing to show: no trigger, or one that is gone.
 */
export function describeTriggerLine(params: {
  kind: TriggerKind;
  chain: TriggerChainState | null;
  readAtMs: number | null;
  local: LocalTrigger | undefined;
  formatTime: (ms: number) => string;
  stale?: boolean;
  /** Wall-clock time of the last check, hours and minutes. */
  formatCheckTime?: (ms: number) => string;
}): TriggerLine | null {
  const { kind, chain, readAtMs, local, formatTime, stale = false } = params;
  const formatCheckTime = params.formatCheckTime ?? formatTime;
  const price = local ? local.price : null;
  const setAtMs = local ? local.setAtMs : null;
  if (chain === null) {
    return local ? { kind, price, setAtMs, status: "Checking", tone: "muted", detail: null } : null;
  }
  if (chain.state === "gone") {
    const justSet = local && readAtMs !== null && local.setAtMs >= readAtMs;
    if (!justSet && !(stale && local)) return null;
    return stale && !justSet
      ? {
          kind,
          price,
          setAtMs,
          status: lastChecked(readAtMs, formatCheckTime),
          tone: "muted",
          detail: null,
        }
      : { kind, price, setAtMs, status: "Checking", tone: "muted", detail: null };
  }
  if (stale) {
    return {
      kind,
      price,
      setAtMs,
      status: lastChecked(readAtMs, formatCheckTime),
      tone: "muted",
      detail: null,
    };
  }
  const nextTry =
    chain.nextAttemptMs !== undefined ? `Next try ${formatTime(chain.nextAttemptMs)}.` : null;
  switch (chain.state) {
    case "armed":
      return { kind, price, setAtMs, status: "Armed", tone: "ok", detail: null };
    case "unfillable":
      return { kind, price, setAtMs, status: UNFILLABLE_STATUS, tone: "warn", detail: nextTry };
    case "blockedByRestingOrders":
      return {
        kind,
        price,
        setAtMs,
        status: "Blocked by your open orders",
        tone: "warn",
        detail: nextTry,
      };
  }
}

function lastChecked(readAtMs: number | null, formatCheckTime: (ms: number) => string): string {
  return readAtMs === null
    ? "Set, not checked yet"
    : `Set, last checked ${formatCheckTime(readAtMs)}`;
}

/** Why a trigger the exchange says cannot place an order is stuck, and what fixes it. */
export function describeUnfillable(
  kind: TriggerKind,
  chain: TriggerChainState,
  formatTime: (ms: number) => string,
): string {
  const retry =
    chain.nextAttemptMs !== undefined && chain.nextAttemptMs > 0
      ? ` It tries again at ${formatTime(chain.nextAttemptMs)}.`
      : "";
  return `This ${TRIGGER_NAME[kind].toLowerCase()} cannot place an order at its size right now. The size may be under the market minimum, or larger than what is left of the position. Choosing the whole position, or a different amount, fixes it.${retry}`;
}

const NOTHING_CHANGED = /\s*Nothing was changed\./g;

/** A refusal's reason without the sentence that says nothing changed. */
export function withoutNothingChanged(reason: string): string {
  const stripped = reason.replace(NOTHING_CHANGED, "").trim();
  return stripped || reason;
}

/**
 * The line for the step that failed after earlier steps had gone through.
 * "Nothing was changed" is true of this step only, so it is left off.
 */
export function describePartialFailure(
  step: { op: "set" | "cancel"; kind: TriggerKind },
  reason: string,
): string {
  const body = withoutNothingChanged(reason);
  const verb = step.op === "set" ? "saved" : "removed";
  return `${TRIGGER_NAME[step.kind]} was not ${verb}: ${body}`;
}

/** What one save will touch, in plain lines, so the shared size and slippage are never a guess. */
export function describeSaveScope(params: {
  changes: TriggerChange[];
  exists: Record<TriggerKind, boolean>;
  local: LocalTriggers;
}): string[] {
  const { changes, exists, local } = params;
  if (changes.length === 0) return [];
  const names = (kinds: TriggerKind[]) =>
    kinds.map((kind) => TRIGGER_NAME[kind].toLowerCase()).join(", ");
  const sets = TRIGGER_KINDS.filter((kind) =>
    changes.some((change) => change.kind === kind && change.op === "set"),
  );
  const cancels = TRIGGER_KINDS.filter((kind) =>
    changes.some((change) => change.kind === kind && change.op === "cancel"),
  );
  const untouched = TRIGGER_KINDS.filter((kind) => !sets.includes(kind) && !cancels.includes(kind));
  const lines: string[] = [];
  if (sets.length > 0) {
    const unchanged = untouched.filter((kind) => exists[kind]);
    lines.push(
      `Saving updates: ${names(sets)}.${unchanged.length > 0 ? ` ${capitalise(names(unchanged))} unchanged.` : ""}`,
    );
  }
  if (cancels.length > 0) lines.push(`Removing: ${names(cancels)}.`);
  const unknown = untouched.filter((kind) => exists[kind] && !local[kind]);
  for (const kind of unknown) {
    lines.push(
      `${TRIGGER_NAME[kind]} was set on another device: its size and slippage are unknown here.`,
    );
  }
  return lines;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Whether a trigger of this kind is on the exchange, as far as this device can tell: reported live, or set here and not yet contradicted. */
export function triggerExists(
  chain: TriggerChainState | null,
  local: LocalTriggers[TriggerKind],
): boolean {
  if (chain === null) return local !== undefined;
  return chain.state !== "gone" || local !== undefined;
}
