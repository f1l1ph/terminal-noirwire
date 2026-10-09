import type { MarketInfo } from "../market-data/types";

export type OrderSide = "buy" | "sell";
export type OrderType = "market" | "limit";
export type TimeInForce = "gtc" | "ioc" | "fok";

export interface WalletIdentity {
  address: string;
}

export interface NewOrderInput {
  market: string;
  side: OrderSide;
  orderType: OrderType;
  /** Decimal string, base units of the market's base asset. */
  quantity: string;
  /** Decimal string. Required for a limit order. */
  limitPrice?: string;
  /** Decimal string. The protective execution bound for a market order. */
  protectionPrice?: string;
  timeInForce?: TimeInForce;
  postOnly?: boolean;
  reduceOnly?: boolean;
  /** Perp orders only. Whole or fractional, bounded by the market's max. */
  leverage?: number;
  /** Idempotency key for reconciling an order of unknown outcome. */
  clientOrderId: string;
  /** Random 64-bit tag, chosen in this browser, so a later tape fill can be matched to this order without any server-side identity. */
  clientTag: string;
}

export type OrderAckStatus = "accepted" | "rejected";

export interface PlaceOrderResult {
  orderId: string;
  clientOrderId: string;
  status: OrderAckStatus;
  reason?: string;
  /** Epoch ms when the venue produced this acknowledgement. */
  confirmedAt: number;
}

export interface CancelResult {
  cancelled: number;
}

export interface Balance {
  asset: string;
  /** Decimal string. */
  total: string;
  /** Decimal string. */
  available: string;
}

export interface Position {
  market: string;
  side: OrderSide;
  /** Decimal string. */
  quantity: string;
  /** Decimal string. */
  entryPrice: string;
  leverage: number;
  /** Decimal string, server's own estimate when supplied. */
  liquidationPrice: string | null;
  /** Decimal string. */
  unrealizedPnl: string | null;
}

export type OpenOrderStatus = "resting" | "partiallyFilled";

export interface OpenOrder {
  orderId: string;
  clientOrderId: string;
  clientTag: string;
  market: string;
  side: OrderSide;
  orderType: OrderType;
  /** Decimal string. */
  quantity: string;
  /** Decimal string. */
  filledQuantity: string;
  /** Decimal string, limit orders only. */
  limitPrice: string | null;
  status: OpenOrderStatus;
  placedAt: number;
  reduceOnly: boolean;
}

export interface OwnFill {
  fillId: string;
  orderId: string;
  clientTag: string;
  market: string;
  side: OrderSide;
  /** Decimal string. */
  price: string;
  /** Decimal string. */
  quantity: string;
  /** Decimal string. */
  fee: string;
  time: number;
}

export interface TraderState {
  balances: Balance[];
  positions: Position[];
  openOrders: OpenOrder[];
  ownFills: OwnFill[];
}

export interface FundResult {
  /** Decimal string. */
  amount: string;
  reference: string;
}

export type TradingMode = "dev" | "rollup";

/**
 * A single contract for whatever places orders. `DevTradingClient` is the
 * only implementation today; a second one that signs transactions and sends
 * them to the rollup directly is added later. The interface carries nothing
 * HTTP-specific, and every amount crosses it as a decimal string, never a
 * floating-point number.
 */
export interface TradingClient {
  readonly mode: TradingMode;
  openAccount(wallet: WalletIdentity): Promise<void>;
  fund(wallet: WalletIdentity): Promise<FundResult>;
  placeOrder(wallet: WalletIdentity, order: NewOrderInput): Promise<PlaceOrderResult>;
  cancelOrder(wallet: WalletIdentity, market: string, orderId: string): Promise<CancelResult>;
  cancelAll(wallet: WalletIdentity, market: string): Promise<CancelResult>;
  /** Fetches the trader's current state once. */
  fetchState(wallet: WalletIdentity): Promise<TraderState>;
  /** Polls fetchState on an interval and pushes updates until unsubscribed. */
  subscribe(wallet: WalletIdentity, listener: (state: TraderState) => void): () => void;
}

export interface MarketSettingsLookup {
  (marketId: string): MarketInfo | undefined;
}
