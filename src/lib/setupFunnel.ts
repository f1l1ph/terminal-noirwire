import { track, type FailureReason, type SetupStepId } from "./analytics";
import { tookBucket } from "./failureReason";

type Store = Pick<Storage, "getItem" | "setItem">;

const DONE_KEY = "noirwire.setup.stepsDone";
const STOP_ASKED_KEY = "noirwire.setup.stopAsked";

/** This browser's local storage, or null where the browser will not give it. */
export function browserStore(): Store | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readDone(store: Store | null): Set<string> {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(DONE_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function writeDone(store: Store | null, done: Set<string>): void {
  try {
    store?.setItem(DONE_KEY, JSON.stringify([...done]));
  } catch {
    // A browser that will not store this only loses the "already" label.
  }
}

/**
 * The setup steps as one page load sees them, so a visitor who returns with
 * steps already done is told apart from one making progress now. A step is
 * done "now" only when this page load saw it as the current step and this
 * browser has not finished it before; otherwise it was done "already".
 */
export class SetupFunnel {
  private readonly startedAt: number;
  private readonly seenAt = new Map<SetupStepId, number>();
  private readonly actedAt = new Map<SetupStepId, number>();
  private readonly doneSent = new Set<SetupStepId>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly store: () => Store | null = browserStore,
    private readonly send: typeof track = track,
  ) {
    this.startedAt = now();
  }

  seen(step: SetupStepId): void {
    if (this.seenAt.has(step)) return;
    this.seenAt.set(step, this.now());
    this.send("setup_step_seen", { step });
  }

  acted(step: SetupStepId): void {
    this.actedAt.set(step, this.now());
    this.send("setup_action", { step });
  }

  done(step: SetupStepId): void {
    if (this.doneSent.has(step)) return;
    this.doneSent.add(step);
    const store = this.store();
    const done = readDone(store);
    const how = this.seenAt.has(step) && !done.has(step) ? "now" : "already";
    if (!done.has(step)) {
      done.add(step);
      writeDone(store, done);
    }
    this.send("setup_step_done", { step, how });
  }

  failed(step: SetupStepId, reason: FailureReason): void {
    const since = this.actedAt.get(step) ?? this.seenAt.get(step) ?? this.startedAt;
    this.send("setup_failed", { step, reason, took: tookBucket(this.now() - since) });
  }
}

/** Whether this browser may still be asked what stopped it; never when storage cannot remember the answer. */
export function mayAskStopReason(store: Store | null): boolean {
  if (!store) return false;
  try {
    return store.getItem(STOP_ASKED_KEY) === null;
  } catch {
    return false;
  }
}

/** Remembers that this browser was asked, so it is never asked again. */
export function markStopReasonAsked(store: Store | null): void {
  try {
    store?.setItem(STOP_ASKED_KEY, "1");
  } catch {
    // Without storage the question is not shown at all (`mayAskStopReason`).
  }
}

/** How long a visitor sits on the deposit step before the question appears. */
export const STOP_ASK_AFTER_MS = 45_000;
