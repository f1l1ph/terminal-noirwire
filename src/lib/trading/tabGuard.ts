/** The subset of `BroadcastChannel` used here. */
export interface TabChannel {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  close(): void;
}

export type OpenChannel = (name: string) => TabChannel | null;

export interface TabGuard {
  /** Whether another tab of this browser holds trading for the account. */
  elsewhere(): boolean;
  /** Takes trading over from the other tab, which is told at once. */
  takeOver(): void;
  /** Called whenever `elsewhere()` changes; returns a function that stops calling. */
  subscribe(listener: () => void): () => void;
  close(): void;
}

type Message = {
  kind: "hello" | "holding" | "claim" | "release";
  from: string;
  since: number;
  at: number;
};

const KINDS = new Set(["hello", "holding", "claim", "release"]);

function messageOf(data: unknown): Message | null {
  if (typeof data !== "object" || data === null) return null;
  const { kind, from, since, at } = data as Partial<Message>;
  return typeof kind === "string" &&
    KINDS.has(kind) &&
    typeof from === "string" &&
    typeof since === "number" &&
    typeof at === "number"
    ? ({ kind, from, since, at } as Message)
    : null;
}

/** The browser's own channel, or null where there is none (an old browser, a server render). */
export const browserChannel: OpenChannel = (name) =>
  typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(name);

/**
 * One trading tab per account in this browser. Two tabs that trade on one
 * account spend each other's order keys, so a tab that opens while another
 * holds trading is told so and stays read-only until its trader takes over.
 * Tabs that start together, or that are freed together when the holder
 * closes, both answer "holding"; only the older one's answer counts, so
 * exactly one of them trades. Of two tabs taken over at once, the later
 * takeover wins in both.
 * Without a channel nothing is shared, so no tab is ever held back.
 */
export function createTabGuard(
  owner: string,
  open: OpenChannel = browserChannel,
  id: string = Math.random().toString(36).slice(2),
  clock: () => number = Date.now,
): TabGuard {
  const since = clock();
  let claimedAt = Number.NEGATIVE_INFINITY;
  const olderThanThis = (message: Message) =>
    message.since < since || (message.since === since && message.from < id);
  const laterClaim = (message: Message) =>
    message.at > claimedAt || (message.at === claimedAt && message.from > id);
  const channel = open(`noirwire-terminal-trading:${owner}`);
  const listeners = new Set<() => void>();
  let elsewhere = false;
  let closed = false;
  const set = (value: boolean) => {
    if (elsewhere === value) return;
    elsewhere = value;
    for (const listener of listeners) listener();
  };
  const send = (kind: Message["kind"], at = clock()) =>
    channel?.postMessage({ kind, from: id, since, at } satisfies Message);

  channel?.addEventListener("message", (event) => {
    const message = messageOf(event.data);
    if (closed || !message || message.from === id) return;
    if (message.kind === "hello" && !elsewhere) send("holding");
    else if (message.kind === "holding" && olderThanThis(message)) set(true);
    else if (message.kind === "claim" && laterClaim(message)) set(true);
    else if (message.kind === "release" && elsewhere) {
      set(false);
      send("hello");
    }
  });
  send("hello");

  return {
    elsewhere: () => elsewhere,
    takeOver() {
      claimedAt = clock();
      set(false);
      send("claim", claimedAt);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    close() {
      closed = true;
      if (!elsewhere) send("release");
      channel?.close();
      listeners.clear();
    },
  };
}
