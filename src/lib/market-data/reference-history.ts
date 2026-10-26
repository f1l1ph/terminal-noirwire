/**
 * Reference price history for the chart's backdrop: public SOL/USD candles
 * from Coinbase Exchange. Only the terminal's server route contacts it (so a
 * visitor's address and timing never reach a third party); the page reads
 * the route. It is outside data, so it is only ever drawn as a labelled
 * reference and every row is validated at both hops; one malformed row
 * rejects the whole response.
 */

const REFERENCE_ORIGIN = "https://api.exchange.coinbase.com";
export const REFERENCE_SOURCE_LABEL = "Coinbase";
export const REFERENCE_LABEL = `SOL/USD reference price, ${REFERENCE_SOURCE_LABEL}`;

/** A refreshed range is not fetched again within this window. */
export const REFERENCE_REFRESH_MS = 60_000;

export type HistoryRange = "1H" | "1D" | "1W" | "1M";
export const HISTORY_RANGES: HistoryRange[] = ["1H", "1D", "1W", "1M"];

interface RangeSpec {
  /** Candle size in seconds; one of the sizes the source accepts. */
  granularitySec: number;
  spanSec: number;
}

/** Each range stays under the source's 300-candle limit per request. */
export const RANGE_SPECS: Record<HistoryRange, RangeSpec> = {
  "1H": { granularitySec: 60, spanSec: 3_600 },
  "1D": { granularitySec: 300, spanSec: 86_400 },
  "1W": { granularitySec: 3_600, spanSec: 604_800 },
  "1M": { granularitySec: 21_600, spanSec: 2_592_000 },
};

export interface ReferenceCandle {
  /** Candle start, seconds since the epoch. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const MAX_CANDLES = 300;
const MAX_PRICE = 1_000_000;

export function referenceHistoryUrl(range: HistoryRange, nowMs: number): string {
  const { spanSec, granularitySec } = RANGE_SPECS[range];
  const end = new Date(Math.floor(nowMs / 1000) * 1000);
  const start = new Date(end.getTime() - spanSec * 1000);
  const query = new URLSearchParams({
    granularity: String(granularitySec),
    start: start.toISOString(),
    end: end.toISOString(),
  });
  return `${REFERENCE_ORIGIN}/products/SOL-USD/candles?${query.toString()}`;
}

function isPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < MAX_PRICE;
}

/**
 * The source answers newest first with rows of [time, low, high, open,
 * close, volume]. Returns ascending candles, or null if the body is not
 * exactly that shape or has fewer than two candles.
 */
export function parseReferenceCandles(body: unknown): ReferenceCandle[] | null {
  if (!Array.isArray(body) || body.length < 2 || body.length > MAX_CANDLES) return null;
  const byTime = new Map<number, ReferenceCandle>();
  for (const row of body) {
    if (!Array.isArray(row) || row.length < 6) return null;
    const [time, low, high, open, close, volume] = row as unknown[];
    if (typeof time !== "number" || !Number.isInteger(time) || time <= 0) return null;
    if (!isPrice(low) || !isPrice(high) || !isPrice(open) || !isPrice(close)) return null;
    if (typeof volume !== "number" || !Number.isFinite(volume) || volume < 0) return null;
    if (low > high || open < low || open > high || close < low || close > high) return null;
    byTime.set(time, { time, open, high, low, close });
  }
  const candles = [...byTime.values()].sort((a, b) => a.time - b.time);
  return candles.length >= 2 ? candles : null;
}

/** The terminal's own server route; browsers never contact the price source themselves. */
export const REFERENCE_PROXY_PATH = "/api/reference-history";

export function isHistoryRange(value: unknown): value is HistoryRange {
  return typeof value === "string" && (HISTORY_RANGES as string[]).includes(value);
}

/**
 * The server route's answer, `{ candles: [{ time, open, high, low, close }] }`,
 * checked as strictly as the source's own rows: it is still outside data to
 * the page. Returns ascending candles, or null on any deviation.
 */
export function parseProxyCandles(body: unknown): ReferenceCandle[] | null {
  if (typeof body !== "object" || body === null) return null;
  const rows = (body as { candles?: unknown }).candles;
  if (!Array.isArray(rows) || rows.length < 2 || rows.length > MAX_CANDLES) return null;
  const candles: ReferenceCandle[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) return null;
    const { time, open, high, low, close } = row as Record<string, unknown>;
    if (typeof time !== "number" || !Number.isInteger(time) || time <= 0) return null;
    if (!isPrice(low) || !isPrice(high) || !isPrice(open) || !isPrice(close)) return null;
    if (low > high || open < low || open > high || close < low || close > high) return null;
    if (candles.length > 0 && time <= candles[candles.length - 1].time) return null;
    candles.push({ time, open, high, low, close });
  }
  return candles;
}

export async function fetchReferenceHistory(
  range: HistoryRange,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<ReferenceCandle[]> {
  const response = await fetchImpl(`${REFERENCE_PROXY_PATH}?range=${range}`, {
    signal,
    credentials: "omit",
  });
  if (!response.ok) throw new Error(`reference history ${response.status}`);
  const candles = parseProxyCandles(await response.json());
  if (!candles) throw new Error("reference history malformed");
  return candles;
}

/** The price at the start of the range: the first candle's open, within one candle of the range's span ago. */
export function rangeStartPrice(candles: ReferenceCandle[]): number | null {
  return candles[0]?.open ?? null;
}

/** Percent change from `from` to `to`; null when either is unusable. */
export function changePercent(from: number | null, to: number): number | null {
  if (from === null || !Number.isFinite(from) || from <= 0 || !Number.isFinite(to)) return null;
  return ((to - from) / from) * 100;
}
