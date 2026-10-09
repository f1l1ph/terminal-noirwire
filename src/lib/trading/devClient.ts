import {
  cancelAllResponseSchema,
  devOrderResponseSchema,
  errorResponseSchema,
  fundResponseSchema,
  traderStateResponseSchema,
} from "../sim-api/schema";
import type {
  Balance,
  CancelResult,
  FundOutcome,
  NewOrderInput,
  PlaceOrderResult,
  Position,
  TraderState,
  TradingClient,
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

function toBalance(asset: string, wire: { balance: string; locked: string }): Balance {
  const availableNum = Number(wire.balance);
  const reservedNum = Number(wire.locked);
  const total =
    Number.isFinite(availableNum) && Number.isFinite(reservedNum)
      ? (availableNum + reservedNum).toFixed(6)
      : wire.balance;
  return { asset, available: wire.balance, reserved: wire.locked, total };
}

function toPosition(market: string, wire: { size: string; entryPrice: string }): Position {
  return { market, size: wire.size, entryPrice: wire.entryPrice };
}

/**
 * Talks to sim-noirwire's local-development trading routes (`POST
 * /v1/dev/orders`, `POST /v1/dev/cancel-all`, `GET /v1/dev/trader`, `POST
 * /v1/fund`), registered only when that service runs with `VENUE=memory`
 * and `DEV_TRADING=1`. Shapes come from `src/lib/sim-api/schema.ts`, read
 * from sim-noirwire's own source.
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
    // There is no open-account route; GET /v1/dev/trader for an address the
    // venue has not seen yet still answers 200 with empty balances (the
    // venue opens a trader lazily), so this is a best-effort warm-up, not a
    // requirement.
    try {
      await this.fetchState(wallet);
    } catch {
      // Ignored; fund() or placeOrder() will still work.
    }
  }

  async fund(wallet: WalletIdentity): Promise<FundOutcome> {
    const url = `${this.baseUrl}/v1/fund`;
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ address: wallet.address }),
      });
    } catch {
      return { kind: "error", message: `Could not reach the simulation service at ${url}` };
    }
    if (response.status === 409) return { kind: "alreadyFunded" };
    if (response.status === 429) return { kind: "rateLimited" };
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const parsedError = errorResponseSchema.safeParse(body);
      return {
        kind: "error",
        message: parsedError.success
          ? parsedError.data.error
          : `${url} answered ${response.status}`,
      };
    }
    const granted = fundResponseSchema.parse(await response.json());
    return { kind: "granted", amount: granted.amount, reference: granted.reference };
  }

  async placeOrder(wallet: WalletIdentity, order: NewOrderInput): Promise<PlaceOrderResult> {
    const response = await this.post("/v1/dev/orders", {
      address: wallet.address,
      market: order.market,
      side: order.side,
      type: order.type,
      price: order.price,
      size: order.size,
      reduceOnly: order.reduceOnly,
    });
    return devOrderResponseSchema.parse(response);
  }

  async cancelAllInMarket(wallet: WalletIdentity, market: string): Promise<CancelResult> {
    const response = await this.post("/v1/dev/cancel-all", { address: wallet.address, market });
    return cancelAllResponseSchema.parse(response);
  }

  async fetchState(wallet: WalletIdentity): Promise<TraderState> {
    const response = await this.get(`/v1/dev/trader?address=${encodeURIComponent(wallet.address)}`);
    const wire = traderStateResponseSchema.parse(response);
    const balances: Record<string, Balance> = {};
    for (const [asset, balance] of Object.entries(wire.balances)) {
      balances[asset] = toBalance(asset, balance);
    }
    const positions: Record<string, Position> = {};
    for (const [market, position] of Object.entries(wire.positions)) {
      positions[market] = toPosition(market, position);
    }
    return {
      trader: wire.trader,
      equity: wire.equity,
      balances,
      positions,
      openOrders: wire.openOrders,
    };
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
