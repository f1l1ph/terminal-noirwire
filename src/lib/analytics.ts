declare global {
  interface Window {
    umami?: {
      track: (eventName: string, eventData?: Record<string, unknown>) => void;
    };
  }
}

export const SETUP_STEPS = ["connect", "verify", "open", "keys", "deposit"] as const;
export type SetupStepId = (typeof SETUP_STEPS)[number];

export const FAILURE_REASONS = [
  "wallet_declined",
  "wallet_unavailable",
  "network_unreachable",
  "request_timeout",
  "server_refused",
  "invite_required",
  "rate_limited",
  "daily_cap",
  "key_storage_unavailable",
  "other",
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export const TOOK_BUCKETS = ["under_5s", "5_30s", "30_120s", "over_120s"] as const;
export type TookBucket = (typeof TOOK_BUCKETS)[number];

export const ORDER_BLOCK_REASONS = [
  "limits_loading",
  "limits_failed",
  "paused",
  "exposure_unreadable",
  "no_funds",
  "stale_price",
  "closing_only",
  "waiting_for_price",
  "invalid_quantity",
  "invalid_amount",
  "over_available",
  "too_small",
  "invalid_price",
  "short_of_funds",
  "changed_since_review",
] as const;
export type OrderBlockReason = (typeof ORDER_BLOCK_REASONS)[number];

export const STOP_ANSWERS = [
  "just_looking",
  "no_usdc_now",
  "not_sure_what_to_do",
  "something_broke",
  "fees_or_minimum",
  "dismissed",
] as const;
export type StopAnswer = (typeof STOP_ANSWERS)[number];

export const APP_ERROR_KINDS = ["route_boundary", "uncaught", "rejection"] as const;
export type AppErrorKind = (typeof APP_ERROR_KINDS)[number];

const OPEN_RESULTS = ["opened", "alreadyOpen", "refused", "notSent", "notAvailable"] as const;
const DEPOSIT_RESULTS = [
  "done",
  "refused",
  "busy",
  "waiting",
  "not-landed",
  "unknown",
  "stranded",
  "storage_refused",
  "error",
] as const;
const ORDER_RESULTS = [
  "open",
  "filled",
  "partiallyFilled",
  "cancelled",
  "rejected",
  "error",
] as const;
const ORDER_TYPES = ["market", "limit"] as const;
const FUN_MODE_STATES = ["on", "off"] as const;
const STEP_HOW = ["now", "already"] as const;

/**
 * Every event the terminal may send, with the only keys it may carry and the
 * closed list of values each key accepts. Nothing here can hold an address,
 * amount, size, price, URL, invite code or error text: a value outside its
 * list is sent as "other", and a key not listed is dropped.
 */
export const EVENT_SCHEMA = {
  wallet_connected: {},
  wallet_verified: {},
  account_opened: {},
  keys_ready: {},
  account_funded: {},
  invite_asked: {},
  account_open_result: { result: OPEN_RESULTS },
  deposit_submitted: {},
  deposit_result: { result: DEPOSIT_RESULTS, reason: FAILURE_REASONS },
  deposit_needs_sol: {},
  deposit_below_minimum: {},
  deposit_stop_reason: { answer: STOP_ANSWERS },
  order_submitted: { type: ORDER_TYPES },
  order_result: { result: ORDER_RESULTS, reason: FAILURE_REASONS },
  ticket_seen: {},
  order_blocked: { reason: ORDER_BLOCK_REASONS },
  quests_enabled: {},
  fun_mode_seen: { state: FUN_MODE_STATES },
  fun_mode_switched: { state: FUN_MODE_STATES },
  setup_step_seen: { step: SETUP_STEPS },
  setup_step_done: { step: SETUP_STEPS, how: STEP_HOW },
  setup_action: { step: SETUP_STEPS },
  setup_failed: { step: SETUP_STEPS, reason: FAILURE_REASONS, took: TOOK_BUCKETS },
  app_error: { kind: APP_ERROR_KINDS },
} as const satisfies Record<string, Record<string, readonly string[]>>;

export type AnalyticsEvent = keyof typeof EVENT_SCHEMA;

type EventData<E extends AnalyticsEvent> = {
  [K in keyof (typeof EVENT_SCHEMA)[E]]?: (typeof EVENT_SCHEMA)[E][K] extends readonly (infer V)[]
    ? V
    : never;
};

const OTHER = "other";
const VERSION_LENGTH = 7;

/** The build that sent an event: the first characters of the deployed commit, or "dev". */
export function buildVersion(
  sha: string | undefined = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,
): string {
  const trimmed = sha?.trim() ?? "";
  return /^[0-9a-f]{7,}$/i.test(trimmed) ? trimmed.slice(0, VERSION_LENGTH).toLowerCase() : "dev";
}

/**
 * The data an event may send: only the schema's keys, each value from its
 * closed list or "other", plus the build version. Anything else is dropped.
 */
export function sanitizeEventData(
  event: string,
  data: Record<string, unknown> | undefined,
  version: string = buildVersion(),
): Record<string, string> | null {
  if (!Object.hasOwn(EVENT_SCHEMA, event)) return null;
  const schema: Record<string, readonly string[]> = EVENT_SCHEMA[event as AnalyticsEvent];
  const clean: Record<string, string> = {};
  for (const [key, allowed] of Object.entries(schema)) {
    if (!data || !Object.hasOwn(data, key)) continue;
    const value = data[key];
    if (value === undefined) continue;
    clean[key] = typeof value === "string" && allowed.includes(value) ? value : OTHER;
  }
  clean.v = version;
  return clean;
}

/**
 * Counts a funnel step. A missing tracker or a tracker that throws is
 * ignored, so analytics can never get in the way of trading.
 */
export function track<E extends AnalyticsEvent>(event: E, data?: EventData<E>): void {
  const clean = sanitizeEventData(event, data as Record<string, unknown> | undefined);
  if (!clean) return;
  try {
    window.umami?.track(event, clean);
  } catch {
    // Analytics never breaks the page.
  }
}

const TRACKER_POLL_MS = 250;
const TRACKER_WAIT_LIMIT_MS = 30_000;

/**
 * Runs `send` once the tracker script has loaded, which happens after the
 * page is interactive, so an event sent on mount is not lost. Gives up after
 * 30 s; returns a cancel.
 */
export function whenTrackerReady(send: () => void): () => void {
  if (window.umami) {
    send();
    return () => {};
  }
  let waited = 0;
  const timer = setInterval(() => {
    waited += TRACKER_POLL_MS;
    if (window.umami) send();
    if (window.umami || waited >= TRACKER_WAIT_LIMIT_MS) clearInterval(timer);
  }, TRACKER_POLL_MS);
  return () => clearInterval(timer);
}

const sentThisPageLoad = new Set<string>();

/** Sends `event` once per page load for the same `key`; later calls with that key do nothing. */
export function trackOnce<E extends AnalyticsEvent>(
  key: string,
  event: E,
  data?: EventData<E>,
): void {
  if (sentThisPageLoad.has(key)) return;
  sentThisPageLoad.add(key);
  track(event, data);
}

/** Forgets what `trackOnce` has sent. Tests only. */
export function resetTrackOnce(): void {
  sentThisPageLoad.clear();
}

const MAX_APP_ERRORS_PER_LOAD = 3;
let appErrorsSent = 0;

/** Counts an app error by kind only, at most three per page load, so a loop of errors cannot flood the counts. */
export function trackAppError(kind: AppErrorKind): void {
  if (appErrorsSent >= MAX_APP_ERRORS_PER_LOAD) return;
  appErrorsSent += 1;
  track("app_error", { kind });
}

/** Forgets the app errors counted so far. Tests only. */
export function resetAppErrors(): void {
  appErrorsSent = 0;
}
