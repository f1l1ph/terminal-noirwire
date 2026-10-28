/**
 * Formatting rules from the design concept, section 9: grouped thousands,
 * a market's own decimal precision, "<0.01" rather than "0.00" for a
 * nonzero amount below display precision, and an em-dash-free
 * "Unavailable" label for anything stale or unknown.
 */

export const UNAVAILABLE = "Unavailable";

function toNumber(value: string | number): number {
  return typeof value === "number" ? value : Number(value);
}

/** A quantity or price at a market's own decimal precision. */
export function formatDecimal(value: string | number, decimals: number): string {
  const num = toNumber(value);
  if (!Number.isFinite(num)) return UNAVAILABLE;
  const smallestUnit = Math.pow(10, -decimals);
  if (num !== 0 && Math.abs(num) < smallestUnit) {
    return `<${smallestUnit.toFixed(decimals)}`;
  }
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(num);
}

/**
 * An amount of the quote token, named by `quoteSymbol` (the venue's own
 * name for it: nUSD on the test deployment, USDC on the USDC one). Never a
 * bare dollar sign; an empty symbol, while it is not yet known, shows the
 * number alone rather than a guessed name.
 */
export function formatMoney(value: string | number, quoteSymbol: string, decimals = 2): string {
  const formatted = formatDecimal(value, decimals);
  if (formatted === UNAVAILABLE) return UNAVAILABLE;
  return quoteSymbol ? `${formatted} ${quoteSymbol}` : formatted;
}

export function formatPercent(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return UNAVAILABLE;
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(decimals)}%`;
}

/** Below 1 s in whole milliseconds, at or above 1 s in seconds to two decimals. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return UNAVAILABLE;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Local HH:mm:ss.SSS, for an order event's primary timestamp. */
export function formatClockTime(date: Date): string {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  const sss = String(date.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${sss}`;
}

/** The secondary, relative label: "just now", "4s", "12m", "3h", "2d". */
export function formatRelativeAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return UNAVAILABLE;
  if (ageMs < 1000) return "just now";
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** Time left until an order's own expiry: "under 1m", "52m", "3h 10m", "2d 3h"; "Expired" once the moment has passed. */
export function formatTimeLeft(expiresAtMs: number, now: number): string {
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(now)) return UNAVAILABLE;
  const leftMs = expiresAtMs - now;
  if (leftMs <= 0) return "Expired";
  const minutes = Math.floor(leftMs / 60_000);
  if (minutes < 1) return "under 1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

/** How old a price is, as shown beside it: "Updated just now", "Updated 42s ago". */
export function formatUpdatedAge(ageMs: number): string {
  const relative = formatRelativeAge(ageMs);
  return relative === "just now" ? "Updated just now" : `Updated ${relative} ago`;
}

/** Clock time for an event from today; a plain date for an older row. */
export function formatEventTime(date: Date, now: Date = new Date()): string {
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return formatClockTime(date);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** A short, non-identifying form of a base58 address: first6…last4. */
export function formatShortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * The rollup deployment's own `network` field (sim-noirwire's
 * `GET /v1/deployment`, e.g. "localnet"/"devnet"), turned into the label a
 * speed or latency figure sits beside - per the second design review, a
 * number measured against a local stack must never be shown without saying
 * so. `isLocalNetwork` is the matching predicate every "local" qualifier
 * (the pulse card, a per-order speed line) reads before adding that word.
 */
export function networkDisplayLabel(network: string): string {
  switch (network) {
    case "localnet":
      return "LOCAL DEMO";
    case "devnet":
      return "DEVNET";
    case "mainnet":
    case "mainnet-beta":
      return "MAINNET";
    default:
      return network.toUpperCase();
  }
}

export function isLocalNetwork(network: string): boolean {
  return network === "localnet";
}
