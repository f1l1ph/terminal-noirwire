/**
 * Exponential backoff with a ceiling, pure and deterministic so the
 * reconnect schedule can be asserted without a real clock. `attempt` is
 * 1 for the first reconnect try, 2 for the second, and so on.
 */
export function backoffDelayMs(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  factor: number,
): number {
  const raw = initialDelayMs * Math.pow(factor, Math.max(attempt - 1, 0));
  return Math.min(raw, maxDelayMs);
}
