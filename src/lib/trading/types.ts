import type { MarketInfo } from "../market-data/types";
import type { OrderStatus, OrderType, Side } from "../sim-api/schema";

export type { OrderStatus, OrderType, Side };

export interface WalletIdentity {
  address: string;
  /**
   * The owner key's secret, hex-encoded. Only `RollupTradingClient` reads
   * this (DESIGN.md section 4: the browser wallet's keypair IS the owner
   * key, so signing a trading instruction needs it); `DevTradingClient`
   * never looks at it. Optional so every other caller can keep building a
   * `WalletIdentity` from the address alone.
   */
  secretKeyHex?: string;
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
  /**
   * A resting limit order's own expiry (RULES.md section 4): once matching
   * reaches it, the remainder is cancelled. Rollup mode only; a dev-mode
   * client ignores it (sim-noirwire's limit orders have no expiry field).
   */
  goodFor?: "untilCancelled" | "1m" | "1h";
}

/**
 * A call whose outcome was not yet certain when it returned (rollup mode
 * only): the device gave up waiting while the instruction could still run
 * on the venue's own clock. `expiresAtMs` is this device's clock reading of
 * when the venue can no longer run it; until `settled` resolves, this
 * call's order-key slot is lent to nothing else, so the same intent must
 * not be resent.
 */
export interface PendingSettlement<T> {
  expiresAtMs: number;
  settled: Promise<T>;
}

export interface PlaceOrderResult {
  orderId: string;
  tag: string;
  status: OrderStatus;
  filledSize: string;
  remainingSize: string;
  reason: string | null;
  /**
   * Rollup mode only: when the order was sent, and when its result was read
   * from the view, both `performance.now()` so they compare directly against
   * the caller's own click timestamp for a precise speed figure. Absent in
   * dev mode and on an order that never reached the venue.
   */
  sentAtMs?: number;
  resultAtMs?: number;
  /**
   * Set only while the outcome is not yet certain. `status`/`reason` above
   * are a provisional placeholder ("open", "Checking with the venue...");
   * await `pending.settled` for what the order actually did.
   */
  pending?: PendingSettlement<PlaceOrderResult>;
}

export interface CancelResult {
  cancelled: number;
  /** A plain reason the cancel could not be sent at all (e.g. every order-key slot busy). Never set alongside `pending`. */
  reason?: string;
  /** Set only while the outcome is not yet certain; see `PendingSettlement`. */
  pending?: PendingSettlement<CancelResult>;
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
  /** Spot wallet balances: dev mode's only balance. */
  balances: Record<string, Balance>;
  /**
   * The separate perpetuals collateral account (RULES.md section 6: "two
   * separate balances of the same token"). Present only in rollup mode;
   * absent (not zeroed) in dev mode, which has one balance, not two.
   */
  collateral?: Balance;
  positions: Record<string, Position>;
  openOrders: OpenOrder[];
}

export type TransferResult =
  | { kind: "ok" }
  | { kind: "error"; message: string }
  /** Set only while the outcome is not yet certain; see `PendingSettlement`. */
  | { kind: "pending"; pending: PendingSettlement<TransferResult> };

/**
 * What one unsigned account read actually established, never collapsed to
 * a single boolean: `notReturned` is the pass case (no data without
 * sign-in); `returned` is a real fail (the read came back with data); a
 * thrown request (timeout, RPC error, transport failure) is `checkFailed`,
 * never silently counted as `notReturned` - the second design review's
 * "a failed or errored unsigned read must never show as empty."
 */
export type AccountReadOutcome =
  { kind: "notReturned" } | { kind: "returned" } | { kind: "checkFailed"; reason: string };

export interface PrivacyCheck {
  /** From the deployment description (e.g. "localnet", "devnet"). */
  network: string;
  checkedAtMs: number;
  /** The unsigned RPC endpoint this check read from. */
  endpoint: string;
  view: { address: string; outcome: AccountReadOutcome };
  book: { address: string; outcome: AccountReadOutcome };
}

export type FundOutcome =
  | { kind: "granted"; amount: string; reference: string }
  | { kind: "alreadyFunded" }
  /**
   * Transient, try again: the per-IP rate limit, or (rollup mode) the
   * venue's daily limit on new accounts. `message`, when present, is the
   * server's own plain-language reason (e.g. "daily limit reached: no more
   * new accounts can be opened today, try again tomorrow") and is shown
   * instead of the generic copy.
   */
  | { kind: "rateLimited"; message?: string }
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
  /**
   * Cancels one resting order by `orderId`. Optional: sim-noirwire's dev
   * routes have no per-order cancel, only cancel-all; the real program does
   * (`cancel_order`), so only `RollupTradingClient` implements this. The UI
   * shows a per-order cancel control only when this is present.
   */
  cancelOrder?(wallet: WalletIdentity, market: string, orderId: string): Promise<CancelResult>;
  /**
   * Moves funds between the perpetuals collateral account and the spot
   * balance of the same asset. Optional: dev mode has one balance, not two,
   * so it has nothing to move between.
   */
  transferBetweenBalances?(
    wallet: WalletIdentity,
    toSpot: boolean,
    amount: string,
  ): Promise<TransferResult>;
  /**
   * Tells the venue to refresh this trader's own view for `market` (the
   * program's `sync_view`). Optional: dev mode's state is always current
   * (every read goes straight to the engine), but a rollup resting order
   * that is filled by someone else's taker order does not touch this
   * trader's view until this is called (DESIGN.md section 3). Call it when
   * an own fill is seen on a resting order (RULES.md section 10's receipts).
   */
  syncMarket?(wallet: WalletIdentity, market: string): Promise<void>;
  /**
   * The concrete evidence behind the privacy claim (DESIGN.md section 1):
   * reads this trader's own view account and `market`'s book account from
   * the rollup's PUBLIC endpoint, unsigned, and reports whether each came
   * back empty. Optional: dev mode has no on-chain accounts to check.
   */
  checkPrivacy?(wallet: WalletIdentity, market: string): Promise<PrivacyCheck>;
  /** Fetches the trader's current state once. */
  fetchState(wallet: WalletIdentity): Promise<TraderState>;
  /** Polls fetchState on an interval and pushes updates until unsubscribed. */
  subscribe(wallet: WalletIdentity, listener: (state: TraderState) => void): () => void;
  /**
   * Ends this wallet's live result subscription and background refreshes,
   * if one was ever opened. Optional: dev mode has no background
   * connection of its own to end. Call when the wallet is cleared/changed
   * and on page unload (`@noirwire/orderbook` 0.5.0's `TraderClient.close`).
   */
  closeWallet?(wallet: WalletIdentity): void;
}

export interface MarketSettingsLookup {
  (marketId: string): MarketInfo | undefined;
}
