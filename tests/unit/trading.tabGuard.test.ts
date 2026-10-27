import { describe, expect, it } from "vitest";
import { createTabGuard, type OpenChannel, type TabChannel } from "@/lib/trading/tabGuard";

/**
 * An in-memory stand-in for BroadcastChannel: a message reaches every other
 * channel of the same name, at once or, with `held`, only on `flush()`.
 */
function bus(held = false): OpenChannel & { flush(): void } {
  const channels = new Map<string, Set<TabChannel & { deliver(data: unknown): void }>>();
  const queue: Array<() => void> = [];
  const open = (name: string) => {
    const peers = channels.get(name) ?? new Set();
    channels.set(name, peers);
    const listeners: Array<(event: { data: unknown }) => void> = [];
    const channel = {
      postMessage(message: unknown) {
        for (const peer of peers) {
          if (peer === channel) continue;
          if (held) queue.push(() => peer.deliver(message));
          else peer.deliver(message);
        }
      },
      addEventListener(_type: "message", listener: (event: { data: unknown }) => void) {
        listeners.push(listener);
      },
      close() {
        peers.delete(channel);
      },
      deliver(data: unknown) {
        for (const listener of listeners) listener({ data });
      },
    };
    peers.add(channel);
    return channel;
  };
  return Object.assign(open, {
    flush() {
      while (queue.length > 0) queue.shift()!();
    },
  });
}

describe("one trading tab per account", () => {
  it("holds back a second tab and leaves the first alone", () => {
    const open = bus();
    const first = createTabGuard("owner", open, "a");
    const second = createTabGuard("owner", open, "b");
    expect(first.elsewhere()).toBe(false);
    expect(second.elsewhere()).toBe(true);
  });

  it("lets the second tab take over, and holds the first back", () => {
    const open = bus();
    const first = createTabGuard("owner", open, "a");
    const second = createTabGuard("owner", open, "b");
    let told = 0;
    first.subscribe(() => void (told += 1));
    second.takeOver();
    expect(second.elsewhere()).toBe(false);
    expect(first.elsewhere()).toBe(true);
    expect(told).toBe(1);
  });

  it("frees a held tab when the tab that held trading closes", () => {
    const open = bus();
    const first = createTabGuard("owner", open, "a");
    const second = createTabGuard("owner", open, "b");
    first.close();
    expect(second.elsewhere()).toBe(false);
  });

  it("lets exactly the older of two tabs trade when they start together", () => {
    const open = bus(true);
    const older = createTabGuard("owner", open, "b", 1);
    const newer = createTabGuard("owner", open, "a", 2);
    open.flush();
    expect(older.elsewhere()).toBe(false);
    expect(newer.elsewhere()).toBe(true);
  });

  it("frees exactly one of two held tabs when the holder closes", () => {
    const open = bus();
    const holder = createTabGuard("owner", open, "h", 1);
    const second = createTabGuard("owner", open, "s", 2);
    const third = createTabGuard("owner", open, "t", 3);
    holder.close();
    expect(second.elsewhere()).toBe(false);
    expect(third.elsewhere()).toBe(true);
  });

  it("keeps accounts apart", () => {
    const open = bus();
    createTabGuard("owner-one", open, "a");
    expect(createTabGuard("owner-two", open, "b").elsewhere()).toBe(false);
  });

  it("holds nothing back where there is no channel", () => {
    const guard = createTabGuard("owner", () => null, "a");
    expect(guard.elsewhere()).toBe(false);
    guard.takeOver();
    guard.close();
    expect(guard.elsewhere()).toBe(false);
  });
});
