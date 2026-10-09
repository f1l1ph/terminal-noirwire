import {
  cancelResponseSchema,
  fundResponseSchema,
  placeOrderResponseSchema,
  traderStateSchema,
} from "./schemas";
import type {
  CancelResult,
  FundResult,
  NewOrderInput,
  PlaceOrderResult,
  TradingClient,
  TraderState,
  WalletIdentity,
} from "./types";

export class TradingRequestError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "TradingRequestError";
  }
}

export interface DevTradingClientOptions {
  baseUrl: string;
  fetchFn?: typeof fetch;
  pollIntervalMs?: number;
  setIntervalFn?: (handler: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;

/**
 * Talks to the simulation service's local-development trading routes.
 * Assumptions about request and response shapes are recorded in
 * docs/BUILD-NOTES.md; the biggest is that there is no per-order cancel
 * route, only cancel-all, so `cancelOrder` cancels every resting order in
 * the market (correct for a single resting order, which is the dev/test
 * flow this terminal exercises).
 */
export class DevTradingClient implements TradingClient {
  readonly mode = "dev" as const;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly setIntervalFn: (handler: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;

  constructor(options: DevTradingClientOptions) {
    this.baseUrl = options.baseUrl;
    // Each default is wrapped rather than assigned directly: these are
    // native, receiver-checked browser functions, and storing one bare on
    // `this` then calling it as `this.fn(...)` throws "Illegal invocation",
    // because the call's receiver becomes this client instance instead of
    // `window`.
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.setIntervalFn = options.setIntervalFn ?? ((handler, ms) => setInterval(handler, ms));
    this.clearIntervalFn = options.clearIntervalFn ?? ((handle) => clearInterval(handle as number));
  }

  async openAccount(wallet: WalletIdentity): Promise<void> {
    // There is no documented open-account route. GET /v1/dev/trader for an
    // address the venue has not seen yet is treated as "not opened"; fund()
    // is what actually creates the trader server-side.
    try {
      await this.fetchState(wallet);
    } catch {
      // Not yet opened. fund() opens it.
    }
  }

  async fund(wallet: WalletIdentity): Promise<FundResult> {
    const response = await this.post("/v1/fund", { address: wallet.address });
    return fundResponseSchema.parse(response);
  }

  async placeOrder(wallet: WalletIdentity, order: NewOrderInput): Promise<PlaceOrderResult> {
    const response = await this.post("/v1/dev/orders", {
      address: wallet.address,
      market: order.market,
      side: order.side,
      orderType: order.orderType,
      quantity: order.quantity,
      limitPrice: order.limitPrice,
      protectionPrice: order.protectionPrice,
      timeInForce: order.timeInForce,
      postOnly: order.postOnly ?? false,
      reduceOnly: order.reduceOnly ?? false,
      leverage: order.leverage,
      clientOrderId: order.clientOrderId,
      clientTag: order.clientTag,
    });
    return placeOrderResponseSchema.parse(response);
  }

  async cancelOrder(
    wallet: WalletIdentity,
    market: string,
    _orderId: string,
  ): Promise<CancelResult> {
    return this.cancelAll(wallet, market);
  }

  async cancelAll(wallet: WalletIdentity, market: string): Promise<CancelResult> {
    const response = await this.post("/v1/dev/cancel-all", { address: wallet.address, market });
    return cancelResponseSchema.parse(response);
  }

  async fetchState(wallet: WalletIdentity): Promise<TraderState> {
    const response = await this.get(`/v1/dev/trader?address=${encodeURIComponent(wallet.address)}`);
    return traderStateSchema.parse(response);
  }

  subscribe(wallet: WalletIdentity, listener: (state: TraderState) => void): () => void {
    let cancelled = false;
    const tick = async () => {
      try {
        const state = await this.fetchState(wallet);
        if (!cancelled) listener(state);
      } catch {
        // Transient failure; the next poll tries again.
      }
    };
    void tick();
    const handle = this.setIntervalFn(() => void tick(), this.pollIntervalMs);
    return () => {
      cancelled = true;
      this.clearIntervalFn(handle);
    };
  }

  private async get(path: string): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const response = await this.request(url, { headers: { accept: "application/json" } });
    return response.json();
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const response = await this.request(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    return response.json();
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchFn(url, init);
    } catch {
      throw new TradingRequestError(`Could not reach the simulation service at ${url}`, url);
    }
    if (!response.ok) {
      throw new TradingRequestError(`${url} answered ${response.status}`, url, response.status);
    }
    return response;
  }
}
