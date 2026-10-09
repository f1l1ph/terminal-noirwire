import { describe, expect, it, vi } from "vitest";
import { MarketSocket, type WebSocketLike } from "@/lib/market-data/socket";

class FakeSocket implements WebSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  close(): void {
    this.closed = true;
  }
}

function fakeClock() {
  const scheduled: { delay: number; handler: () => void; id: number }[] = [];
  let nextId = 1;
  const setTimeoutFn = (handler: () => void, timeoutMs: number) => {
    const id = nextId++;
    scheduled.push({ delay: timeoutMs, handler, id });
    return id;
  };
  const clearTimeoutFn = (id: unknown) => {
    const index = scheduled.findIndex((entry) => entry.id === id);
    if (index >= 0) scheduled.splice(index, 1);
  };
  const fireNext = () => {
    const entry = scheduled.shift();
    if (entry) entry.handler();
  };
  return { setTimeoutFn, clearTimeoutFn, scheduled, fireNext };
}

describe("MarketSocket reconnect", () => {
  it("opens, reconnects on an unexpected close with growing backoff, and resets on reopen", () => {
    const sockets: FakeSocket[] = [];
    const createSocket = vi.fn(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    const states: string[] = [];
    const clock = fakeClock();
    const socket = new MarketSocket(
      "wss://example.test/v1/stream",
      { onMessage: vi.fn(), onStateChange: (state) => states.push(state) },
      {
        createSocket,
        setTimeoutFn: clock.setTimeoutFn,
        clearTimeoutFn: clock.clearTimeoutFn,
        initialDelayMs: 500,
        maxDelayMs: 4_000,
        backoffFactor: 2,
      },
    );

    socket.connect();
    expect(states).toEqual(["connecting"]);
    expect(sockets).toHaveLength(1);

    sockets[0].onclose?.();
    expect(states).toEqual(["connecting", "reconnecting"]);
    expect(clock.scheduled).toHaveLength(1);
    expect(clock.scheduled[0].delay).toBe(500);

    clock.fireNext();
    expect(sockets).toHaveLength(2);
    expect(states.at(-1)).toBe("reconnecting");

    sockets[1].onclose?.();
    expect(clock.scheduled[0].delay).toBe(1_000);
    clock.fireNext();
    expect(sockets).toHaveLength(3);

    sockets[2].onopen?.();
    expect(states.at(-1)).toBe("open");

    sockets[2].onclose?.();
    expect(clock.scheduled[0].delay).toBe(500);
  });

  it("stops reconnecting once closed by the caller", () => {
    const sockets: FakeSocket[] = [];
    const createSocket = vi.fn(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    const clock = fakeClock();
    const socket = new MarketSocket(
      "wss://example.test/v1/stream",
      { onMessage: vi.fn(), onStateChange: vi.fn() },
      { createSocket, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn },
    );
    socket.connect();
    socket.close();
    expect(sockets[0].closed).toBe(true);
    expect(socket.connectionState).toBe("closed");

    sockets[0].onclose?.();
    expect(clock.scheduled).toHaveLength(0);
  });

  it("parses a valid message and drops an invalid one without closing", () => {
    const sockets: FakeSocket[] = [];
    const createSocket = vi.fn(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    const onMessage = vi.fn();
    const onInvalidMessage = vi.fn();
    const clock = fakeClock();
    const socket = new MarketSocket(
      "wss://example.test/v1/stream",
      { onMessage, onStateChange: vi.fn(), onInvalidMessage },
      { createSocket, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn },
    );
    socket.connect();
    sockets[0].onmessage?.({
      data: JSON.stringify({ type: "price", market: "NSOL-PERP", price: "150.25", time: 1 }),
    });
    expect(onMessage).toHaveBeenCalledWith({
      type: "price",
      market: "NSOL-PERP",
      price: "150.25",
      time: 1,
    });

    sockets[0].onmessage?.({ data: JSON.stringify({ type: "unknown" }) });
    expect(onInvalidMessage).toHaveBeenCalledOnce();
    expect(socket.connectionState).not.toBe("closed");
  });
});
