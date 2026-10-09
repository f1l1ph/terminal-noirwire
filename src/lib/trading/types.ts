import type { MarketInfo } from "../market-data/types";
import type { OrderStatus, OrderType, Side } from "../sim-api/schema";

export type { OrderStatus, OrderType, Side };

export interface WalletIdentity {
  address: string;
}

/**
 * Every order carries a price: the venue requires one for every order type,
 * including `market` (there it is the worst acceptable execution price, the
 * protective bound the design concept calls for). See sim-noirwire's
 * `MemoryVenue.validateShape`.
 */
export interface NewOrderInput {
  market: string;
  side: Side;
  type: OrderType;
  price: string;
  size: string;
  reduceOnly?: boolean;
}

export interface PlaceOrderResult {
  orderId: string;
  tag: string;
  status: OrderStatus;
  filledSize: string;
  remainingSize: string;
  reason: string | null;
}

export interface CancelResult {
  cancelled: number;
}

export interface Balance {
  asset: string;
  /** Spendable now (the engine's `balance`, excluding anything locked for a resting order). */
  available: string;
  /** Reserved against a resting order (the engine's `locked`). */
  reserved: string;
  /** `available + reserved`. */
  total: string;
}

/** Signed: positive is long, negative is short, zero means no position. */
export interface Position {
  market: string;
  size: string;
  entryPrice: string;
}

export interface OpenOrder {
  orderId: string;
  tag: string;
  market: string;
  side: Side;
  type: string;
  price: string | null;
  size: string;
  remainingSize: string;
  reduceOnly: boolean;
}

export interface TraderState {
  trader: string;
  /** Free balance plus unrealised perp PnL and pending funding; can differ from `balances`. */
  equity: string;
  balances: Record<string, Balance>;
  positions: Record<string, Position>;
  openOrders: OpenOrder[];
}

export type FundOutcome =
  | { kind: "granted"; amount: string; reference: string }
  | { kind: "alreadyFunded" }
  | { kind: "rateLimited" }
  | { kind: "error"; message: string };

export type TradingMode = "dev" | "rollup";

/**
 * A single contract for whatever places orders. `DevTradingClient` is the
 * only implementation today; a second one that signs transactions and sends
 * them to the rollup directly is added later. Every amount crosses it as a
 * decimal string, never a floating-point number. There is no per-order
 * cancel route in sim-noirwire: cancellation is always scoped to every
 * resting order a trader has in one market.
 */
export interface TradingClient {
  readonly mode: TradingMode;
  openAccount(wallet: WalletIdentity): Promise<void>;
  fund(wallet: WalletIdentity): Promise<FundOutcome>;
  placeOrder(wallet: WalletIdentity, order: NewOrderInput): Promise<PlaceOrderResult>;
  /** Cancels every resting order this trader has in `market`. There is no narrower scope. */
  cancelAllInMarket(wallet: WalletIdentity, market: string): Promise<CancelResult>;
  /** Fetches the trader's current state once. */
  fetchState(wallet: WalletIdentity): Promise<TraderState>;
  /** Polls fetchState on an interval and pushes updates until unsubscribed. */
  subscribe(wallet: WalletIdentity, listener: (state: TraderState) => void): () => void;
}

export interface MarketSettingsLookup {
  (marketId: string): MarketInfo | undefined;
}
