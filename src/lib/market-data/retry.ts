import { backoffDelayMs } from "./backoff";

const INITIAL_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
const BACKOFF_FACTOR = 2;

export interface RetryOptions {
  /** Checked before every try and after every wait: a caller that went away stops the loop. */
  isCancelled: () => boolean;
  /** Called after each failed try. */
  onFailure?: () => void;
  /** Tries before giving up; without it the loop runs until it succeeds or is cancelled. */
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `load` until it succeeds, waiting longer between tries (1 s, 2 s, up
 * to 30 s). Resolves with its answer, or with undefined once cancelled or out
 * of attempts: a service that is down is asked again, never given up on.
 */
export async function loadWithRetry<T>(
  load: () => Promise<T>,
  { isCancelled, onFailure, maxAttempts = Infinity, sleep = wait }: RetryOptions,
): Promise<T | undefined> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (isCancelled()) return undefined;
    try {
      return await load();
    } catch {
      if (isCancelled()) return undefined;
      onFailure?.();
    }
    if (attempt < maxAttempts) {
      await sleep(backoffDelayMs(attempt, INITIAL_DELAY_MS, MAX_DELAY_MS, BACKOFF_FACTOR));
    }
  }
  return undefined;
}
