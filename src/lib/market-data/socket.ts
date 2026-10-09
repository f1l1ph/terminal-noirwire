import { backoffDelayMs } from "./backoff";
import { wsMessageSchema, type WsMessage } from "./types";

export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";

export interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface MarketSocketHandlers {
  onMessage(message: WsMessage): void;
  onStateChange(state: ConnectionState): void;
  /** A message the schema could not parse. Never crashes the socket. */
  onInvalidMessage?(raw: unknown): void;
}

export interface MarketSocketOptions {
  createSocket: WebSocketFactory;
  setTimeoutFn?: (handler: () => void, timeoutMs: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
}

const DEFAULTS = {
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  backoffFactor: 2,
};

/**
 * One websocket connection to the simulation service, with reconnect and
 * exponential backoff. The socket constructor and the timer functions are
 * both injectable so reconnect timing can be driven by a controlled clock in
 * tests, with no real network and no real timers.
 */
export class MarketSocket {
  private readonly createSocket: WebSocketFactory;
  private readonly setTimeoutFn: (handler: () => void, timeoutMs: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly backoffFactor: number;

  private state: ConnectionState = "closed";
  private socket: WebSocketLike | null = null;
  private attempt = 0;
  private closedByCaller = false;
  private reconnectHandle: unknown = null;

  constructor(
    private readonly url: string,
    private readonly handlers: MarketSocketHandlers,
    options: MarketSocketOptions,
  ) {
    this.createSocket = options.createSocket;
    // Wrapped rather than assigned directly: `setTimeout`/`clearTimeout` are
    // native, receiver-checked browser functions. Storing one bare on
    // `this` and calling it as `this.fn(...)` throws "Illegal invocation",
    // because the call's receiver becomes this socket instance, not
    // `window`.
    this.setTimeoutFn = options.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as number));
    this.initialDelayMs = options.initialDelayMs ?? DEFAULTS.initialDelayMs;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
    this.backoffFactor = options.backoffFactor ?? DEFAULTS.backoffFactor;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  connect(): void {
    this.closedByCaller = false;
    this.open();
  }

  close(): void {
    this.closedByCaller = true;
    if (this.reconnectHandle !== null) {
      this.clearTimeoutFn(this.reconnectHandle);
      this.reconnectHandle = null;
    }
    this.socket?.close();
    this.socket = null;
    this.setState("closed");
  }

  private open(): void {
    this.setState(this.attempt === 0 ? "connecting" : "reconnecting");
    const socket = this.createSocket(this.url);
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.setState("open");
    };
    socket.onmessage = (event) => {
      let parsed: unknown;
      try {
        parsed = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch {
        this.handlers.onInvalidMessage?.(event.data);
        return;
      }
      const result = wsMessageSchema.safeParse(parsed);
      if (!result.success) {
        this.handlers.onInvalidMessage?.(parsed);
        return;
      }
      this.handlers.onMessage(result.data);
    };
    socket.onclose = () => {
      if (this.closedByCaller) return;
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      socket.close();
    };
  }

  private scheduleReconnect(): void {
    this.attempt += 1;
    const delay = backoffDelayMs(
      this.attempt,
      this.initialDelayMs,
      this.maxDelayMs,
      this.backoffFactor,
    );
    this.setState("reconnecting");
    this.reconnectHandle = this.setTimeoutFn(() => this.open(), delay);
  }

  private setState(state: ConnectionState): void {
    if (state === this.state) return;
    this.state = state;
    this.handlers.onStateChange(state);
  }
}
