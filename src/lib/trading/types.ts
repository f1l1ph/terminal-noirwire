import type { Connection } from "@solana/web3.js";
import type { MarketInfo } from "../market-data/types";
import type { UnknownHold } from "../rollup/accountMemory";
import type { PublicDeployment } from "../rollup/deployment";
import type { OpenRefusal } from "../rollup/openClient";
import type { OrderKeyStatus as SetupStatus } from "../rollup/orderKeySetup";
import type { OwnerSigner } from "../wallet/ownerSigner";
import type { OrderStatus, OrderType, Side } from "../sim-api/schema";

export type { OrderStatus, OrderType, Side };

export interface WalletIdentity {
  address: string;
  /**
   * Signs for the owner key. On mainnet this is the connected wallet's
   * signer with the network check in front of every signature
   * (`mainnetOwnerSigner`), and the only way a mainnet session is signed.
   * `DevTradingClient` never looks at it.
   */
  signer?: OwnerSigner;
  /**
   * The owner key's secret, hex-encoded: the built-in browser wallet of a
   * test build. A mainnet build refuses it (`secretOwner`). Optional so
   * every other caller can build a `WalletIdentity` from the address alone.
   */
  secretKeyHex?: string;
}

/**
 * Whether an owner's account exists on the rollup: read from its view, so
 * `unknown` is a read that failed, never "absent". `declined` is a sign-in
 * the owner turned down in the wallet, so the account was never read.
 */
export type AccountStatus = "unknown" | "absent" | "open" | "declined";

/** What a market's account states about trading in it, in the units the form uses. */
export interface MarketLimits {
  /** Initial margin ratio, in basis points. */
  imBps: number;
  /** Maintenance margin ratio, in basis points. */
  mmBps: number;
  takerFeeBps: number;
  /** How far a crossing price may sit from the mark: a bid above it or an ask below it is refused. */
  bandBps: number;
  /** The smallest order size, in base units. */
  minSize: string;
  /** The smallest order value (price times size), in quote units. */
  minNotional: string;
  /** The most one seat may hold on one side, in base units: the position on that side, the resting orders on it and a new order together. */
  positionCap: string;
  /** The most resting orders one seat may have in this market. */
  maxOpenOrders: number;
}

/** What opening an account came to; the UI renders each kind and never a bare success. */
export type OpenAccountOutcome =
  | { kind: "opened"; reference: string }
  /** The view shows the account is open (it was already, or an answer that left that doubtful has been checked). */
  | { kind: "alreadyOpen" }
  /** The service turned the request away or could not be reached; `mayBeOpen` means the view could not settle it either, so read it before trying again. */
  | { kind: "refused"; refusal: OpenRefusal }
  /** Nothing was sent: the prepared transaction or the wallet's signature was not what was asked for, or the wallet declined. */
  | { kind: "notSent"; reason: string }
  /** This deployment opens accounts another way (test funds), not through the invite-gated routes. */
  | { kind: "notAvailable" };

/** How the owner consents to account actions on a deployment: by a message they sign, or by a transaction their wallet signs. */
export type OwnerAuth = "message" | "transaction";

/**
 * What a withdrawal signed by an order key came to. `withdrawn` is proven by
 * the view; `refused` and `tooLarge` moved nothing and left the key live;
 * `didNotRun` is a send that can no longer run; `undetermined` is a send the
 * owner's key replacement made unprovable either way.
 */
export type KeyWithdrawal =
  | { kind: "withdrawn" }
  | { kind: "refused"; code: number | null }
  | { kind: "tooLarge" }
  | { kind: "didNotRun" }
  | { kind: "undetermined" };

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
  /** `available + reserved`; for the perpetuals collateral, the deposited collateral instead (margin and P&L move `available`). */
  total: string;
  /** Perpetuals collateral only: no fresh mark, so `available` is a fail-closed "0", not a measurement. */
  availableUnknown?: boolean;
  /** Perpetuals collateral only: what may move out to spot, never more than the deposited collateral (unrealised profit is not paid out) nor the free margin. Absent when `available` is unknown. */
  transferable?: string;
  /** Perpetuals collateral only: `available` was priced from marks that go stale at this time (ms); after it the figure is unknown, not a measurement. */
  availableValidUntilMs?: number;
}

/** Signed: positive is long, negative is short, zero means no position. */
export interface Position {
  market: string;
  size: string;
  /** Rollup mode: the position's break-even price (`-quote / base`), which is its average entry only until it has been reduced or had funding settled. */
  entryPrice: string;
  /** Rollup mode: the slot's signed net quote cash flow in quote units (`quote`), as the program holds it. */
  quote?: string;
  /** Rollup mode: the market account's own maintenance margin ratio, in basis points. */
  maintenanceMarginBps?: number;
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
  /** The order's own expiry in unix milliseconds; null when it never expires, absent when the source does not report one. */
  expiresAtMs?: number | null;
}

export interface TraderState {
  trader: string;
  /** Free balance plus unrealised perp PnL and pending funding; can differ from `balances`. Null when a perp mark is missing (rollup mode). */
  equity: string | null;
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
  /**
   * Rollup mode: for each spot market id, which `balances` entries hold its
   * base and quote tokens, named as the venue's deployment description
   * names them. Absent in dev mode, where `balances` is keyed by the
   * market's own base and quote names.
   */
  spotAssets?: Record<string, SpotAssets>;
  /**
   * Rollup mode: the account holds a position or resting order in a market
   * this terminal does not trade (or cannot bind to trustworthy settings). Its
   * size, margin and liquidation price cannot be known here, so the margin
   * figures are unknown and orders that could grow risk are blocked.
   */
  exposureUnreadable?: boolean;
  /**
   * Rollup mode: the account holds no seat, so every balance is zero. This is
   * the account's normal state before its first deposit and after a withdrawal
   * takes everything; the first collateral deposit takes a seat.
   */
  unseated?: boolean;
}

export interface SpotAssets {
  base: string;
  quote: string;
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
  /** The deployment hands out no test funds at all: asking again changes nothing. */
  | { kind: "noFaucet" }
  | { kind: "error"; message: string };

/**
 * Where the owner's order keys stand on this device. A new device (or cleared
 * storage) waits for old orders to lapse before replacing the keys with one
 * owner-signed transaction. `seedPersisted` false means the browser would not
 * promise to keep the seed: clearing site data then costs one more such
 * replacement (funds are not at risk); null before a seed was made here.
 */
export type OrderKeyState = SetupStatus & { seedPersisted: boolean | null };

export type TradingMode = "dev" | "rollup";

/**
 * A single contract for whatever places orders: `DevTradingClient` against
 * sim-noirwire's dev routes, `RollupTradingClient` signing in this browser
 * against the real program. Every amount crosses it as a decimal string,
 * never a floating-point number.
 */
export interface TradingClient {
  readonly mode: TradingMode;
  /**
   * Opens the owner's account through the invite-gated routes (mainnet).
   * `invite` is the code NoirWire issued for this address, if the
   * deployment asks for one. Elsewhere an account opens with its first
   * funding, and this answers `notAvailable`.
   */
  openAccount(wallet: WalletIdentity, invite?: string): Promise<OpenAccountOutcome>;
  /**
   * Whether the owner's account exists, read from its view. `fresh` reads it
   * through a new session, which sees an account opened after the current one
   * was built. Optional: dev mode opens accounts lazily.
   */
  accountStatus?(wallet: WalletIdentity, options?: { fresh?: boolean }): Promise<AccountStatus>;
  /** Whether the owner's account holds a seat right now, confirmed with the exchange by a `sync_view` (a refresh only). Optional: dev mode has no seats. */
  confirmSeat?(wallet: WalletIdentity): Promise<boolean>;
  /** The rollup connection signed in as the owner, which deposits and withdrawals read the rollup through. Optional: dev mode has no rollup. */
  rollupReader?(wallet: WalletIdentity): Promise<Connection>;
  /** How the owner consents to account actions here, as the deployment says; "transaction" when it does not. Needs no wallet. Optional: dev mode has no such choice. */
  ownerAuth?(): Promise<OwnerAuth>;
  /** Withdraws `atoms` of the seat's free collateral to the owner's own token account, signed by an order key and never by the wallet. Optional: dev mode has no rollup. */
  withdrawByKey?(
    wallet: WalletIdentity,
    atoms: bigint,
    /** Called with each signed withdrawal before it is dispatched; if it fails the withdrawal is not sent. When given, a call that fails having dispatched nothing throws `NotDispatched`. */
    onSigned?: (raw: Uint8Array) => Promise<void>,
  ): Promise<KeyWithdrawal>;
  /** The symbols of the markets that currently let only listed makers rest orders, read from each market's account. Optional: dev mode has no such list. */
  makersListedMarkets?(wallet: WalletIdentity): Promise<ReadonlySet<string>>;
  /** Each market's trading limits as its account states them, by market symbol. Optional: dev mode has no market accounts. */
  marketLimits?(wallet: WalletIdentity): Promise<ReadonlyMap<string, MarketLimits>>;
  /** Tells the listener whether automatic sign-in has stopped because the exchange refused a freshly signed token, now and at every change. Optional: dev mode has no sign-in. */
  subscribeSessionStopped?(
    wallet: WalletIdentity,
    listener: (stopped: boolean) => void,
  ): () => void;
  /** Tells the listener each time this wallet's session is replaced (a token refused and replaced, a refresh, the owner signing in again), as soon as the new one is in place. Optional: dev mode has no session. */
  subscribeSessionGeneration?(wallet: WalletIdentity, listener: () => void): () => void;
  /** The owner's own action after automatic sign-in stopped: signs in once more. Optional: dev mode has no sign-in. */
  signInAgain?(wallet: WalletIdentity): Promise<void>;
  /** The deployment the wallet's session was built against. Optional: dev mode has no session. */
  sessionDeployment?(wallet: WalletIdentity): Promise<PublicDeployment>;
  /** Reports where the order keys stand while they are set up or replaced. Optional: dev mode has none. */
  subscribeOrderKeys?(wallet: WalletIdentity, listener: (state: OrderKeyState) => void): () => void;
  fund(wallet: WalletIdentity): Promise<FundOutcome>;
  /** The account as of the last view shown, valued against the marks as they are now, with no read. Null when nothing has been shown yet. Optional: dev mode prices on the venue. */
  repriceState?(wallet: WalletIdentity): TraderState | null;
  /**
   * Whether this browser already learned that the deployment hands out no
   * test funds, so the grant is not offered again after a reload. Optional:
   * dev mode always has a faucet.
   */
  knownNoFaucet?(): Promise<boolean>;
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
   * Answers whether the view was refreshed; false means ask again.
   */
  syncMarket?(wallet: WalletIdentity, market: string): Promise<boolean>;
  /** The rollup's clock now in unix milliseconds, read afresh; null when it cannot be read. Optional: dev mode has no rollup clock. */
  rollupNowMs?(wallet: WalletIdentity): Promise<number | null>;
  /** How far the rollup's clock runs ahead of this device's, in milliseconds (negative when behind); null while it cannot be read. Optional: dev mode has no rollup clock. */
  clockOffsetMs?(wallet: WalletIdentity): Promise<number | null>;
  /**
   * The concrete evidence behind the privacy claim (DESIGN.md section 1):
   * reads this trader's own view account and `market`'s book account from
   * the rollup's PUBLIC endpoint, unsigned, and reports whether each came
   * back empty. Optional: dev mode has no on-chain accounts to check.
   */
  checkPrivacy?(wallet: WalletIdentity, market: string): Promise<PrivacyCheck>;
  /**
   * An order whose outcome is unknown (`OrderOutcomeUnknownError`) holds its
   * market against another order. Releases that hold, once the outcome is
   * proven or the user has cleared it. Optional: dev mode has no such case.
   */
  releaseUnknownOutcome?(wallet: WalletIdentity, market: string, tag?: string): void;
  /** The held order for this market, kept across a reload; null when nothing is held. */
  readUnknownOutcome?(wallet: WalletIdentity, market: string): Promise<UnknownHold | null>;
  /** Fetches the trader's current state once. */
  fetchState(wallet: WalletIdentity): Promise<TraderState>;
  /** Pushes the trader's state until unsubscribed: polled in dev mode, pushed by the rollup's own account subscription in rollup mode. */
  subscribe(
    wallet: WalletIdentity,
    listener: (state: TraderState) => void,
    /** Called when the account cannot be read at all (sign-in or connection failure), so a failed read is never shown as an empty account. */
    onError?: (error: Error) => void,
  ): () => void;
  /**
   * Ends this wallet's live result subscription and background refreshes,
   * if one was ever opened. Optional: dev mode has no background
   * connection of its own to end. Call when the wallet is cleared/changed
   * and on page unload (`@noirwire/orderbook`'s `TraderClient.close`, 0.5.0 on).
   */
  closeWallet?(wallet: WalletIdentity): void;
}

export interface MarketSettingsLookup {
  (marketId: string): MarketInfo | undefined;
}
