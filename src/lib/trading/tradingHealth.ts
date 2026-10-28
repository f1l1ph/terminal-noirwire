import { backoffDelayMs } from "../market-data/backoff";
import { healthResponseSchema } from "../sim-api/schema";

/** The service is asked about its market maker this often while it answers. */
export const HEALTH_POLL_MS = 15_000;
const HEALTH_MAX_DELAY_MS = 120_000;
const HEALTH_TIMEOUT_MS = 8_000;
const SERVICE_NOT_READY = 503;
const MAX_REASON_LENGTH = 200;

/** Shown beside the order ticket while the market maker has no quotes up. */
export const TRADING_PAUSED_NOTICE =
  "Trading is paused: the market maker has no quotes up. Your resting orders stay.";

/** What the ticket says to someone who picks a market order while trading is paused. */
export const MARKET_ORDERS_PAUSED_REASON =
  "Market orders are off while trading is paused. A limit order can still rest.";

/**
 * Whether a pause stops this order. Only an order that can rest goes through,
 * since nothing can fill while the market maker is down, and a reduce-only
 * order, which may still find something to fill against.
 */
export function pauseStopsOrder(
  paused: boolean,
  order: { canRest: boolean; reduceOnly: boolean },
): boolean {
  return paused && !order.canRest && !order.reduceOnly;
}

/** Shown beside a reduce-only order, which is still accepted while trading is paused. */
export const CLOSING_WHILE_PAUSED_NOTE =
  "You can still close, but there may be nothing to fill against while the market maker is down.";

/** Why a limit order that cannot rest is off while trading is paused. */
export const NON_RESTING_ORDERS_PAUSED_REASON =
  "This order fills now or cancels, and nothing can fill while trading is paused.";

/** The market maker has no quotes up. `reason` is the service's own words, kept only when they read as plain text. */
export interface TradingPause {
  reason: string | null;
}

const PLAIN_TEXT = /^[A-Za-z0-9 .,:;'()%/_+-]+$/;

/** The service's reason when it reads as a plain sentence, null for anything else (markup, braces, a stack trace, an empty or very long text). */
export function plainHealthReason(reason: string | undefined): string | null {
  const text = reason?.trim();
  if (!text || text.length > MAX_REASON_LENGTH || !PLAIN_TEXT.test(text)) return null;
  return text;
}

/**
 * Asks the public health route whether the market maker has quotes up. Null
 * when it does, or when the service says nothing about it (it is asleep, or
 * not a service that reports it); a pause otherwise. Throws when the service
 * cannot be reached or answers something unexpected, so the caller can wait
 * longer before asking again. The route answers 503 with the same body while
 * the service is starting up, which still carries what we read.
 */
export async function fetchTradingPause(
  baseUrl: string,
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
): Promise<TradingPause | null> {
  const response = await fetchFn(`${baseUrl}/v1/health`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
  });
  if (!response.ok && response.status !== SERVICE_NOT_READY) {
    throw new Error(`health answered ${response.status}`);
  }
  const { trading } = healthResponseSchema.parse(await response.json());
  if (!trading || trading.ready) return null;
  return { reason: plainHealthReason(trading.reason) };
}

/** How long to wait before the next ask: the poll gap, doubled for each answer in a row that failed, up to a ceiling. */
export function healthPollDelayMs(failuresInARow: number): number {
  return failuresInARow <= 0
    ? HEALTH_POLL_MS
    : backoffDelayMs(failuresInARow + 1, HEALTH_POLL_MS, HEALTH_MAX_DELAY_MS, 2);
}
