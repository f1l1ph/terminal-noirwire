import { backoffDelayMs } from "../market-data/backoff";

/** A sync that did not go through is asked again after this long, then twice that, and so on up to the ceiling. */
const FIRST_RETRY_MS = 2_000;
const MAX_RETRY_MS = 60_000;

export function fillSyncDelayMs(attempt: number): number {
  return backoffDelayMs(attempt, FIRST_RETRY_MS, MAX_RETRY_MS, 2);
}

/**
 * Runs `sync` until it reports success, waiting longer between tries (never
 * more than a minute) and never giving up. It calls `onDone` only once the
 * sync has succeeded. Returns the way to stop: a stopped run never calls
 * `onDone`, so what a sync was for is never marked as done by one that did not
 * finish.
 */
export function syncUntilDone(sync: () => Promise<boolean>, onDone: () => void): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = async (tries: number): Promise<void> => {
    let done = false;
    try {
      done = await sync();
    } catch {
      done = false;
    }
    if (stopped) return;
    if (done) {
      onDone();
      return;
    }
    timer = setTimeout(() => void attempt(tries + 1), fillSyncDelayMs(tries));
  };
  void attempt(1);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
