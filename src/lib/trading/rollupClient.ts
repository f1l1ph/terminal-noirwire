import { PublicKey, type Connection } from "@solana/web3.js";
import { browserLocalStorage, bytesToHex, type KeyValueStore } from "../wallet/index";
import { signChecked, SignedTransactionRefused } from "../rollup/ownerSend";
import {
  isExpectedOpen,
  isExpectedOpenWindow,
  prepareOpen,
  prepareOpenMessage,
  submitOpen,
  submitOpenMessage,
  type OpenRefusal,
} from "../rollup/openClient";
import { messageDeclined, OwnerActionRefused, signOwnerAction } from "../rollup/ownerMessages";
import { orderSeedPersisted } from "../rollup/orderSeedStore";
import type { OrderKeyStatus } from "../rollup/orderKeySetup";
import { redactToken, scrubError } from "../rollup/redact";
import { TOKEN_REFRESH_MARGIN_MS } from "../rollup/signInToken";
import {
  fetchDeployment,
  quoteSymbolOf,
  usesOwnerMessages,
  type DeploymentOverrides,
  type PublicDeployment,
} from "../rollup/deployment";
import { openAndFund } from "../rollup/fundingClient";
import {
  cancelErrorToResult,
  cancelToResult,
  KEYS_IN_USE_ELSEWHERE_REASON,
  placedToResult,
  placeUnknownToResult,
  POSITION_ALREADY_REDUCED_REASON,
  refusalNumberOf,
  resultRefusalNumber,
  thrownToResult,
  transferErrorToResult,
} from "../rollup/outcome";
import { PROGRAM_ERROR } from "../rollup/refusals";
import { pinnedBaseDecimals } from "../rollup/markets";
import {
  loadHolds,
  markAccountOpened,
  removeHold,
  saveHold,
  wasAccountOpened,
  type UnknownHold,
} from "../rollup/accountMemory";
import { trackSecret, untrackSecret } from "../rollup/secretStore";
import {
  buildRealSession,
  retriesSignIn,
  SessionAuthError,
  trustedProgramId,
  type RollupSession,
  type RollupSessionDeps,
} from "../rollup/session";
import {
  connectionTo,
  ORDER_TYPE_CODE,
  ownerActionText,
  programAddresses,
  SIDE_CODE,
  randomSecret,
  TransactionFailed,
  VIEW_NOT_READABLE_MESSAGE,
  WithdrawalUnknown,
  type Placed,
  type View,
} from "../rollup/sdk";
import {
  amountToQuoteAtoms,
  chainAtomsToPrice,
  lotsToSize,
  marketUnitsFromChain,
  type MarketUnits,
  priceToChainAtoms,
  quoteAtomsToAmount,
  sizeToLots,
} from "../rollup/units";
import { priceDecimalsOf, sizeDecimalsOf } from "../market-data/precision";
import { isStale, STALE_MARK_MS } from "../market-data/selectors";
import { summarizeMargin, type PerpExposure } from "./accountMargin";
import { wireOrderType } from "./orderType";
import type {
  AccountReadOutcome,
  AccountStatus,
  Balance,
  CancelResult,
  FundOutcome,
  KeyWithdrawal,
  MarketSettingsLookup,
  NewOrderInput,
  OpenAccountOutcome,
  OpenOrder,
  OrderKeyState,
  OwnerAuth,
  PlaceOrderResult,
  Position,
  PrivacyCheck,
  SpotAssets,
  TraderState,
  TradingClient,
  TransferResult,
  WalletIdentity,
} from "./types";
import { OrderOutcomeUnknownError } from "./unknownOutcome";

/**
 * One unsigned read, with a real three-way outcome: a thrown request
 * (transport/RPC error) is `checkFailed`, never collapsed into the same
 * "empty" result a genuine no-data response produces. Fixes the earlier
 * `.catch(() => null)` pattern the second design review flagged - that
 * made a failed read indistinguishable from a passing one.
 */
async function readAccountUnsigned(
  connection: Connection,
  address: PublicKey,
): Promise<AccountReadOutcome> {
  try {
    const account = await connection.getAccountInfo(address);
    return account === null ? { kind: "notReturned" } : { kind: "returned" };
  } catch (error) {
    return {
      kind: "checkFailed",
      reason: error instanceof Error ? error.message : "The unsigned read did not complete.",
    };
  }
}

/**
 * The rollup's sign-in token lasts 30 days (the endpoint's own `expiresAt`,
 * read by hand on devnet) and is kept per owner on this device. A session is
 * rebuilt, and the owner asked to sign in again, only when its token is
 * about to lapse or the rollup stops accepting it.
 */
const GRANT_SYNC_ATTEMPTS = 8;
const GRANT_SYNC_GAP_MS = 1_500;
const GOOD_FOR_SECONDS: Record<"1m" | "1h", bigint> = { "1m": 60n, "1h": 3_600n };
/**
 * Passed explicitly on every keyed call (place/cancel/transfer/sync) so this
 * client can compute `PendingSettlement.expiresAtMs` itself from the same
 * value and the same wall clock the package uses internally (`Date.now()`),
 * rather than mirroring the package's own default (also 5s) and risking it
 * drifting out of sync with a future release.
 */
const DEFAULT_EXPIRY_SECONDS = 5;
/**
 * How long a live subscription is trusted to deliver an order's result
 * before the view is read as well. The package's own 500 ms starts a read
 * that a slower result then has to wait behind: the client does not look at
 * a pushed result while a read is in flight, a full round trip on devnet.
 */
const RESULT_PUSH_WAIT_MS = 1_500;
/** Shown when the package gave up before it sent anything: no hold, the form is free to try again. */
const NOT_SENT_REASON = "Nothing was sent. The order could not be prepared just now. Try again.";

export interface RollupTradingClientOptions {
  simUrl: string;
  /** Overrides for `/v1/deployment`'s URLs/program id - a container or a hosted deployment reaching the network at an address the browser cannot. */
  overrides?: DeploymentOverrides;
  marketSettingsLookup: MarketSettingsLookup;
  storage?: KeyValueStore;
  fetchFn?: typeof fetch;
  now?: () => number;
  /** Testability seam: a fake session (and so a fake of the package's client) for unit tests. Builds a real one by default. */
  buildSession?: (wallet: WalletIdentity, deps: RollupSessionDeps) => Promise<RollupSession>;
}

/** This terminal's string market id, bound against `/v1/deployment`'s numeric one. */
interface MarketBinding {
  marketId: string;
  numericId: number;
  units: MarketUnits;
  sizeDecimals: number;
  priceDecimals: number;
  isPerp: boolean;
  quoteTokenSymbol: string;
}

/** One keyed call's result with the program's refusal number when the call was refused, so a refusal that ran nothing can be told from the rest. */
interface KeyedAttempt<T> {
  value: T;
  refusal: number | null;
}

interface RestingRead {
  orders: OpenOrder[];
  bidLots: bigint;
  askLots: bigint;
}

type StateListener = (state: TraderState) => void;

interface OpenSession {
  session: Promise<RollupSession>;
  /** The signer the session was built for; a wallet that comes back with another is not served by this session. */
  signer: WalletIdentity["signer"];
  stopWatching: Promise<() => void>;
  /** The build has finished, one way or the other. */
  settled: boolean;
  /** The wallet was closed while this was still being built: close it as soon as it lands. */
  closeWhenSettled: boolean;
}

function closeSession({ session, stopWatching }: OpenSession): void {
  void stopWatching.then((stop) => stop()).catch(() => {});
  void session.then((built) => built.close()).catch(() => {});
}

/**
 * A deployment that answered "no faucet" once is remembered in this browser,
 * keyed by the program and its Exchange account, so a reload neither offers
 * test funds again nor spends another request against the network's daily
 * funding limit asking for them.
 */
function noFaucetKey(programId: PublicKey): string {
  return `noirwire-terminal-no-faucet:${programId.toBase58()}:${programAddresses(programId).exchange.toBase58()}`;
}

function readFlag(storage: KeyValueStore, key: string): boolean {
  try {
    return storage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(storage: KeyValueStore, key: string): void {
  try {
    storage.setItem(key, "1");
  } catch {
    // Best effort: without storage the next reload asks the service once more.
  }
}

/**
 * Every `/v1/deployment` market this terminal's `marketSettingsLookup` also
 * knows about, matched by its string symbol (identical on both sides - no
 * base/quote/kind matching needed now that the deployment names markets by
 * the same id `/v1/markets` uses). A typed size becomes lots through the
 * market's lot (checked against its on-chain account when the session was
 * built) and this build's own pinned base decimals, never the decimals the
 * service reports.
 */
function bindMarkets(
  session: RollupSession,
  marketSettingsLookup: MarketSettingsLookup,
): Map<string, MarketBinding> {
  const bindings = new Map<string, MarketBinding>();
  for (const market of session.deployment.markets) {
    const settings = marketSettingsLookup(market.symbol);
    const baseDecimals = pinnedBaseDecimals(market.symbol);
    if (!settings || baseDecimals === null) continue;
    bindings.set(market.symbol, {
      marketId: market.symbol,
      numericId: market.marketId,
      units: marketUnitsFromChain(BigInt(market.lotSize), baseDecimals),
      sizeDecimals: sizeDecimalsOf(settings),
      priceDecimals: priceDecimalsOf(settings),
      isPerp: market.kind === "perp",
      quoteTokenSymbol: market.quoteToken.symbol,
    });
  }
  return bindings;
}

function bindingByNumericId(
  bindings: Map<string, MarketBinding>,
  numericId: number,
): MarketBinding | null {
  for (const binding of bindings.values()) {
    if (binding.numericId === numericId) return binding;
  }
  return null;
}

/**
 * Trades directly against the real on-chain order book, signed in this
 * browser: nothing but public market data goes through sim-noirwire. See
 * docs/BUILD-NOTES.md, "Rollup trading client," for the full account of how
 * this reconciles against `@noirwire/orderbook` and sim-noirwire's rollup
 * routes, and every assumption it makes.
 */
export class RollupTradingClient implements TradingClient {
  readonly mode = "rollup" as const;
  private readonly storage: KeyValueStore;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly buildSession: (
    wallet: WalletIdentity,
    deps: RollupSessionDeps,
  ) => Promise<RollupSession>;
  private sessions = new Map<string, OpenSession>();
  private orderKeyListeners = new Map<string, Set<(state: OrderKeyState) => void>>();
  private lastOrderKeys = new Map<string, OrderKeyState>();
  private listeners = new Map<string, Set<StateListener>>();
  private errorListeners = new Map<string, Set<(error: Error) => void>>();
  private newestResultsWritten = new Map<string, number>();
  /** address -> the newest view shown for it, with its session, so the account can be re-valued against newer marks without a read. */
  private lastViews = new Map<string, { session: RollupSession; view: View }>();
  /** address -> perp market id -> the resting orders last read from the view, with the slot's open lots at that moment. */
  private restingByMarket = new Map<string, Map<number, RestingRead>>();
  /** `address:market` -> the secret (hex) of an order that may have reached the venue, until its outcome is proven or released. */
  private unresolvedOrders = new Map<string, UnknownHold>();

  constructor(private readonly options: RollupTradingClientOptions) {
    this.storage = options.storage ?? browserLocalStorage();
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => Date.now());
    this.buildSession = options.buildSession ?? buildRealSession;
  }

  /** A mainnet client is the one built with the pinned network; it never faucets and opens accounts through the invite-gated routes. */
  private get isMainnet(): boolean {
    return this.options.overrides?.pins !== undefined;
  }

  private sessionDeps(wallet: WalletIdentity): RollupSessionDeps {
    return {
      simUrl: this.options.simUrl,
      overrides: this.options.overrides,
      fetchFn: this.fetchFn,
      now: this.now,
      onOrderKeys: (status) => this.emitOrderKeys(wallet.address, status),
    };
  }

  private emitOrderKeys(address: string, status: OrderKeyStatus): void {
    const state: OrderKeyState = { ...status, seedPersisted: orderSeedPersisted() };
    this.lastOrderKeys.set(address, state);
    for (const listener of this.orderKeyListeners.get(address) ?? []) listener(state);
  }

  subscribeOrderKeys(wallet: WalletIdentity, listener: (state: OrderKeyState) => void): () => void {
    const listeners = this.orderKeyListeners.get(wallet.address) ?? new Set();
    this.orderKeyListeners.set(wallet.address, listeners);
    listeners.add(listener);
    const last = this.lastOrderKeys.get(wallet.address);
    if (last) listener(last);
    return () => {
      listeners.delete(listener);
    };
  }

  /** The wallet's session, or a new one when the signer it was built for is no longer the wallet's. */
  private ensureOpen(wallet: WalletIdentity): OpenSession {
    const existing = this.sessions.get(wallet.address);
    if (existing && existing.signer !== wallet.signer) return this.replaceSession(wallet, existing);
    if (existing) {
      existing.closeWhenSettled = false;
      return existing;
    }
    return this.openSession(wallet);
  }

  private ensureSession(wallet: WalletIdentity): Promise<RollupSession> {
    return this.ensureOpen(wallet).session;
  }

  /**
   * Replaces `stale` with a new session, unless this wallet already has a
   * different one: every caller that found the same session unusable shares
   * the one replacement, so a wallet is never asked to sign in twice at once
   * and one new session never closes another.
   */
  private replaceSession(wallet: WalletIdentity, stale: OpenSession | undefined): OpenSession {
    const current = this.sessions.get(wallet.address);
    if (current && current !== stale) return current;
    const next = this.openSession(wallet);
    if (stale) closeSession(stale);
    return next;
  }

  private refreshSession(wallet: WalletIdentity): Promise<RollupSession> {
    return this.replaceSession(wallet, this.sessions.get(wallet.address)).session;
  }

  private openSession(wallet: WalletIdentity): OpenSession {
    const session = this.buildSession(wallet, this.sessionDeps(wallet));
    const opened: OpenSession = {
      session,
      signer: wallet.signer,
      stopWatching: session.then((built) => this.watchView(built)),
      settled: false,
      closeWhenSettled: false,
    };
    opened.stopWatching.catch(() => {});
    this.sessions.set(wallet.address, opened);
    session.then(
      () => {
        opened.settled = true;
        if (opened.closeWhenSettled && this.sessions.get(wallet.address) === opened) {
          this.sessions.delete(wallet.address);
          closeSession(opened);
        }
      },
      () => {
        // A build that failed is not kept as this wallet's session: the next
        // call builds again rather than rejecting until the wallet is closed.
        opened.settled = true;
        if (this.sessions.get(wallet.address) === opened) this.sessions.delete(wallet.address);
      },
    );
    return opened;
  }

  /** Pushes this session's view to the wallet's listeners: once now, then on every change the rollup reports. */
  private async watchView(session: RollupSession): Promise<() => void> {
    const stop = session.client.subscribeView((view) => this.emitState(session, view));
    const address = session.owner.publicKey.toBase58();
    try {
      const view = await session.client.view();
      // A missing view reads the same as the SDK's own "not readable" answer.
      if (!view) throw new Error(VIEW_NOT_READABLE_MESSAGE);
      this.emitState(session, view);
    } catch (error) {
      const notReadable = error instanceof Error && error.message === VIEW_NOT_READABLE_MESSAGE;
      if (notReadable && !wasAccountOpened(this.storage, address)) {
        // This wallet has never been seen with an account: no view yet means
        // it is empty. The subscription reports it once it exists.
        for (const listener of this.listeners.get(address) ?? []) {
          listener(this.emptyState(session));
        }
      } else {
        // A failed read, or an account seen before that now reads as missing
        // (a lagging or refused read looks the same): it stays unknown.
        const failure = notReadable
          ? new Error("This account was opened before but cannot be read right now.")
          : error instanceof Error
            ? scrubError(error)
            : new Error(redactToken(String(error)));
        for (const onError of this.errorListeners.get(address) ?? []) onError(failure);
      }
    }
    return () => void stop();
  }

  private emptyState(session: RollupSession): TraderState {
    return {
      trader: session.owner.publicKey.toBase58(),
      equity: "0",
      balances: {},
      collateral: {
        asset: quoteSymbolOf(session.deployment) ?? "",
        available: "0",
        reserved: "0",
        total: "0",
      },
      positions: {},
      openOrders: [],
      spotAssets: spotAssetsOf(session.deployment),
    };
  }

  /** A view older than one already shown is dropped: the order result and the subscription arrive on separate sockets, in either order. */
  private emitState(session: RollupSession, view: View): void {
    const address = session.owner.publicKey.toBase58();
    if (view.resultsWritten < (this.newestResultsWritten.get(address) ?? 0)) return;
    this.newestResultsWritten.set(address, view.resultsWritten);
    markAccountOpened(this.storage, address);
    const state = this.mapViewFrom(session, view);
    for (const listener of this.listeners.get(address) ?? []) listener(state);
  }

  /**
   * The account as of the newest view shown, valued against the marks as they
   * are now. No read goes out. Null before any view has been shown.
   */
  repriceState(wallet: WalletIdentity): TraderState | null {
    const last = this.lastViews.get(wallet.address);
    return last ? this.mapViewFrom(last.session, last.view) : null;
  }

  /** Ends this wallet's session (its live subscription and background refreshes), if one is open. */
  closeWallet(wallet: WalletIdentity): void {
    this.lastOrderKeys.delete(wallet.address);
    this.lastViews.delete(wallet.address);
    const existing = this.sessions.get(wallet.address);
    if (!existing) return;
    if (!existing.settled) {
      // Still signing in: dropping it here would make the next caller start a
      // second sign-in (a second wallet prompt). It is closed when it lands,
      // unless the wallet asks for it again before then.
      existing.closeWhenSettled = true;
      return;
    }
    this.sessions.delete(wallet.address);
    closeSession(existing);
  }

  /**
   * Runs `fn` against this wallet's session. Building the session again is
   * retried once, and only for a `SessionAuthError` (a failed sign-in, which
   * happens before any call exists); the session is also refreshed first
   * once its sign-in token is about to lapse. `fn` itself is never run
   * twice: nothing it throws says whether something already went out.
   */
  private async withSession<T>(
    wallet: WalletIdentity,
    fn: (session: RollupSession) => Promise<T>,
  ): Promise<T> {
    let open = this.ensureOpen(wallet);
    let session: RollupSession;
    try {
      session = await open.session;
    } catch (error) {
      if (!(error instanceof SessionAuthError) || !retriesSignIn(error.cause)) throw error;
      open = this.replaceSession(wallet, open);
      session = await open.session;
    }
    if (session.tokenExpiresAtMs - this.now() < TOKEN_REFRESH_MARGIN_MS) {
      open = this.replaceSession(wallet, open);
      session = await open.session;
    }
    return fn(session);
  }

  private bindings(session: RollupSession): Map<string, MarketBinding> {
    return bindMarkets(session, this.options.marketSettingsLookup);
  }

  /** Whether the owner's view exists, as the session's reader sees it: absent only on the SDK's own "not readable" answer. */
  private async viewStatus(session: RollupSession): Promise<AccountStatus> {
    try {
      const view = await session.client.view();
      return view ? "open" : "absent";
    } catch (error) {
      const notReadable = error instanceof Error && error.message === VIEW_NOT_READABLE_MESSAGE;
      return notReadable ? "absent" : "unknown";
    }
  }

  async rollupReader(wallet: WalletIdentity): Promise<Connection> {
    return this.withSession(wallet, async (session) => {
      if (!session.reader) throw new Error("This session has no rollup connection to read through");
      return session.reader;
    });
  }

  async ownerAuth(): Promise<OwnerAuth> {
    const deployment = await fetchDeployment(
      this.options.simUrl,
      this.options.overrides,
      this.fetchFn,
    );
    return usesOwnerMessages(deployment) ? "message" : "transaction";
  }

  /**
   * The seat's free collateral to the owner's own token account, signed by one
   * of this device's order keys. A refusal and a packet too large for the
   * exchange's market count both leave the key live and move nothing; a send
   * the client stopped waiting for is settled by the view, and one that an
   * owner key replacement made unprovable is reported as such, never as done.
   */
  async withdrawByKey(wallet: WalletIdentity, atoms: bigint): Promise<KeyWithdrawal> {
    return this.withSession(wallet, async (session): Promise<KeyWithdrawal> => {
      try {
        if (!session.client.withdrawByKey) {
          throw new Error("This session cannot withdraw by order key");
        }
        await session.client.withdrawByKey(session.collateralToken, atoms);
      } catch (error) {
        if (error instanceof TransactionFailed) return { kind: "refused", code: error.code };
        if (error instanceof WithdrawalUnknown) {
          const settled = await error.settled;
          if (settled === null) return { kind: "didNotRun" };
          if ("undetermined" in settled) return { kind: "undetermined" };
        } else if (error instanceof Error && /transaction too large/i.test(error.message)) {
          return { kind: "tooLarge" };
        } else {
          throw error;
        }
      }
      session.saveKeyCheckpoint();
      return { kind: "withdrawn" };
    });
  }

  async accountStatus(wallet: WalletIdentity): Promise<AccountStatus> {
    try {
      return await this.withSession(wallet, (session) => this.viewStatus(session));
    } catch {
      return "unknown";
    }
  }

  /**
   * Whether the market's maker list is on right now, read from its account.
   * On mainnet an order is sent as immediate-or-cancel whenever this is true
   * or cannot be read, so a switch made after the session was built can
   * never let a limit rest. Test builds do not ask.
   */
  private async makersListedNow(session: RollupSession, numericId: number): Promise<boolean> {
    if (!this.isMainnet) return false;
    try {
      if (!session.readMakersListed) return true;
      return await session.readMakersListed(numericId);
    } catch {
      return true;
    }
  }

  async makersListedMarkets(wallet: WalletIdentity): Promise<ReadonlySet<string>> {
    return this.withSession(wallet, async (session) => {
      const listed = new Set<string>();
      for (const [symbol, binding] of this.bindings(session)) {
        if (await this.makersListedNow(session, binding.numericId)) listed.add(symbol);
      }
      return listed;
    });
  }

  /** The view as a fresh session reads it, which sees an account opened after the earlier session was built. */
  private async settledStatus(wallet: WalletIdentity): Promise<AccountStatus> {
    try {
      return await this.viewStatus(await this.refreshSession(wallet));
    } catch {
      return "unknown";
    }
  }

  async openAccount(wallet: WalletIdentity, invite?: string): Promise<OpenAccountOutcome> {
    if (!this.isMainnet) {
      // Nothing to do ahead of funding: there is no bare "open without
      // funding" route, and deriving the owner/order keys (ensureSession) has
      // no network cost worth doing eagerly. See `fund()`.
      try {
        await this.ensureSession(wallet);
      } catch {
        // Best effort, matching DevTradingClient.openAccount.
      }
      return { kind: "notAvailable" };
    }
    try {
      return await this.openThroughGate(wallet, invite);
    } catch (error) {
      scrubError(error);
      const reason =
        error instanceof SignedTransactionRefused || error instanceof OwnerActionRefused
          ? error.reason
          : error instanceof Error
            ? error.message
            : "the account could not be opened";
      return { kind: "notSent", reason: redactToken(reason) };
    }
  }

  /**
   * Opens the account through sim-noirwire's invite-gated routes, signing
   * only a transaction rebuilt and compared here (`isExpectedOpen`) and only
   * accepting the wallet's answer when it is that same transaction
   * (`signChecked`). An answer that leaves it doubtful whether the account
   * was opened is settled by reading the view, never by guessing.
   */
  private async openThroughGate(
    wallet: WalletIdentity,
    invite?: string,
  ): Promise<OpenAccountOutcome> {
    const session = await this.withSession(wallet, (built) => Promise.resolve(built));
    const before = await this.viewStatus(session);
    if (before === "open") {
      markAccountOpened(this.storage, wallet.address);
      return { kind: "alreadyOpen" };
    }
    if (before === "unknown") {
      throw new Error("Your account could not be read, so it was not opened. Try again shortly.");
    }
    if (usesOwnerMessages(session.deployment)) return this.openByMessage(wallet, session, invite);
    const owner = session.owner.publicKey;
    const orderKeys = session.orderKeyPublicKeys.map((key) => new PublicKey(key));
    const prepared = await prepareOpen(
      {
        simUrl: this.options.simUrl,
        owner: owner.toBase58(),
        orderKeys: session.orderKeyPublicKeys,
        invite,
      },
      this.fetchFn,
    );
    if (prepared.kind !== "prepared") return this.afterRefusal(wallet, prepared);
    const refusal = isExpectedOpen(prepared.transaction, {
      programId: trustedProgramId(this.options.overrides),
      gate: session.gate,
      owner,
      orderKeys,
      nowMs: this.now(),
      expiresAtMs: prepared.expiresAtMs,
    });
    if (refusal) return { kind: "notSent", reason: refusal };
    const signed = await signChecked(session.owner, prepared.transaction);
    const submitted = await submitOpen(
      { simUrl: this.options.simUrl, owner: owner.toBase58(), signedTx: signed },
      this.fetchFn,
    );
    if (submitted.kind !== "submitted") return this.afterRefusal(wallet, submitted);
    markAccountOpened(this.storage, wallet.address);
    await this.settledStatus(wallet);
    return { kind: "opened", reference: submitted.reference };
  }

  /**
   * Opens the account by a message the owner signs, on a deployment that says
   * so. The service answers only with the expiry; the text is built here from
   * this session's own owner, its device order keys and the pinned program,
   * never from anything the service sends, and the wallet is never shown a
   * transaction.
   */
  private async openByMessage(
    wallet: WalletIdentity,
    session: RollupSession,
    invite?: string,
  ): Promise<OpenAccountOutcome> {
    const owner = session.owner.publicKey;
    const orderKeys = session.orderKeyPublicKeys.map((key) => new PublicKey(key));
    const prepared = await prepareOpenMessage(
      {
        simUrl: this.options.simUrl,
        owner: owner.toBase58(),
        orderKeys: session.orderKeyPublicKeys,
        invite,
      },
      this.fetchFn,
    );
    if (prepared.kind !== "prepared") return this.afterRefusal(wallet, prepared);
    const refusal = isExpectedOpenWindow(prepared.expiresAtMs, this.now());
    if (refusal) return { kind: "notSent", reason: refusal };
    const programId = trustedProgramId(this.options.overrides);
    let signed: Awaited<ReturnType<typeof signOwnerAction>>;
    try {
      signed = await signOwnerAction(
        session.owner,
        ownerActionText("open", programId, owner, orderKeys, prepared.expiresAt),
        { action: "open", programId, keys: orderKeys, expiresAt: prepared.expiresAt },
      );
    } catch (error) {
      if (error instanceof OwnerActionRefused || !messageDeclined(error)) throw error;
      return { kind: "notSent", reason: "You declined the message" };
    }
    const submitted = await submitOpenMessage(
      {
        simUrl: this.options.simUrl,
        owner: owner.toBase58(),
        signature: signed.signature,
        expiresAt: prepared.expiresAt,
      },
      this.fetchFn,
    );
    if (submitted.kind !== "submitted") return this.afterRefusal(wallet, submitted);
    markAccountOpened(this.storage, wallet.address);
    await this.settledStatus(wallet);
    return { kind: "opened", reference: submitted.reference };
  }

  /** A refusal of the open service as an outcome; the two that leave the account possibly open are settled by the view first. */
  private async afterRefusal(
    wallet: WalletIdentity,
    refusal: OpenRefusal,
  ): Promise<OpenAccountOutcome> {
    if (refusal.kind !== "mayBeOpen" && refusal.kind !== "accountOpen") {
      return { kind: "refused", refusal };
    }
    if ((await this.settledStatus(wallet)) === "open") {
      markAccountOpened(this.storage, wallet.address);
      return { kind: "alreadyOpen" };
    }
    return { kind: "refused", refusal: { kind: "mayBeOpen" } };
  }

  async knownNoFaucet(): Promise<boolean> {
    if (this.isMainnet) return true;
    return readFlag(this.storage, noFaucetKey(trustedProgramId(this.options.overrides)));
  }

  async fund(wallet: WalletIdentity): Promise<FundOutcome> {
    if (await this.knownNoFaucet()) return { kind: "noFaucet" };
    const session = await this.ensureSession(wallet);
    try {
      await session.client.view();
      markAccountOpened(this.storage, wallet.address);
      return { kind: "alreadyFunded" };
    } catch {
      // No view yet: account is not open. Fall through to open + fund.
    }
    const outcome = await openAndFund(
      this.options.simUrl,
      session.owner,
      session.orderKeyPublicKeys,
      session.collateralToken,
      this.fetchFn,
      trustedProgramId(this.options.overrides),
    );
    if (outcome.kind === "noFaucet") {
      writeFlag(this.storage, noFaucetKey(trustedProgramId(this.options.overrides)));
    }
    if (outcome.kind === "granted") {
      markAccountOpened(this.storage, wallet.address);
      // The session's client was built before the account existed, so its
      // reader may not yet see the view; a fresh session re-establishes it
      // cleanly rather than guessing whether a retry is needed.
      const funded = await this.refreshSession(wallet);
      await this.showGrantedBalance(funded);
    }
    return outcome;
  }

  /**
   * A deposit credits the ledger's seat, not the trader's view: only an
   * instruction signed by an order key copies the seat across. The copy can
   * run before the deposit has landed, so it is repeated until the view
   * shows the collateral.
   */
  private async showGrantedBalance(session: RollupSession): Promise<void> {
    const anyMarket = session.deployment.markets[0];
    if (!anyMarket) return;
    for (let attempt = 0; attempt < GRANT_SYNC_ATTEMPTS; attempt += 1) {
      try {
        await session.client.syncView(anyMarket.marketId);
        session.saveKeyCheckpoint();
        const view = await session.client.view();
        this.emitState(session, view);
        const collateral = this.mapViewFrom(session, view).collateral;
        if (collateral && Number(collateral.total) > 0) return;
      } catch {
        // Not readable yet: the next attempt asks again.
      }
      await new Promise((resolve) => setTimeout(resolve, GRANT_SYNC_GAP_MS));
    }
  }

  async placeOrder(wallet: WalletIdentity, order: NewOrderInput): Promise<PlaceOrderResult> {
    const held = this.heldOrder(wallet, order.market);
    if (held) throw new OrderOutcomeUnknownError(held);
    return this.withSession(wallet, async (session) => {
      const attempt = await this.runWithKeyResync(
        session,
        () => this.placeOnce(wallet, session, order),
        (result) => ({ ...result, reason: KEYS_IN_USE_ELSEWHERE_REASON }),
      );
      if (order.reduceOnly && attempt.refusal === PROGRAM_ERROR.reduceOnlyWouldIncrease) {
        return this.explainReduceRefusal(session, order, attempt.value);
      }
      return attempt.value;
    });
  }

  /**
   * Another tab or device that used an order key leaves this one holding a
   * dead key, which the program refuses as NotOrderKey. The refusal ran
   * nothing, so one resync from the view and one more try is safe; a second
   * refusal means the other tab or device is still trading on the account.
   */
  private async runWithKeyResync<T>(
    session: RollupSession,
    run: () => Promise<KeyedAttempt<T>>,
    inUseElsewhere: (value: T) => T,
  ): Promise<KeyedAttempt<T>> {
    let attempt = await run();
    if (attempt.refusal !== PROGRAM_ERROR.notOrderKey) return attempt;
    if (await this.resyncKeys(session)) attempt = await run();
    return attempt.refusal === PROGRAM_ERROR.notOrderKey
      ? { ...attempt, value: inUseElsewhere(attempt.value) }
      : attempt;
  }

  private async resyncKeys(session: RollupSession): Promise<boolean> {
    if (!session.resyncKeys) return false;
    try {
      session.resyncKeys(await session.client.view());
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A reduce-only order is refused when there is nothing left to reduce. The
   * account view only changes when the program is asked to sync it, so a
   * position closed by liquidation still shows until then: sync, read again,
   * and say so when the position is gone or smaller than it was shown.
   */
  private async explainReduceRefusal(
    session: RollupSession,
    order: NewOrderInput,
    refused: PlaceOrderResult,
  ): Promise<PlaceOrderResult> {
    const shown = this.lastViews.get(session.owner.publicKey.toBase58());
    const before = shown
      ? this.mapViewFrom(shown.session, shown.view).positions[order.market]
      : null;
    const binding = this.bindings(session).get(order.market);
    try {
      if (binding) {
        try {
          await session.client.syncView(binding.numericId, DEFAULT_EXPIRY_SECONDS);
          session.saveKeyCheckpoint();
        } catch {
          // The read below still shows whatever the view holds now.
        }
      }
      const view = await session.client.view();
      this.emitState(session, view);
      const after = this.mapViewFrom(session, view).positions[order.market];
      const reduced =
        !after || (before && Math.abs(Number(after.size)) < Math.abs(Number(before.size)));
      return reduced ? { ...refused, reason: POSITION_ALREADY_REDUCED_REASON } : refused;
    } catch {
      return refused;
    }
  }

  private async placeOnce(
    wallet: WalletIdentity,
    session: RollupSession,
    order: NewOrderInput,
  ): Promise<KeyedAttempt<PlaceOrderResult>> {
    const binding = this.bindings(session).get(order.market);
    if (!binding) throw new Error(`${order.market} was not found on chain`);
    const price = priceToChainAtoms(binding.units, order.price);
    const size = sizeToLots(binding.units, order.size);
    const makersListedNow = await this.makersListedNow(session, binding.numericId);
    const secret = randomSecret();
    const expiry = expiryFor(order.goodFor, this.now);
    const expiresAtMs = this.now() + DEFAULT_EXPIRY_SECONDS * 1000;
    const refusalContext = {
      maxPriceAgeSeconds: session.maxPriceAgeSeconds?.get(binding.numericId),
      isPerp: binding.isPerp,
      side: order.side,
    };
    // Tracked before the send, so an order that lands after this call
    // gave up on it still has its fills recognised as this trader's own.
    trackSecret(this.storage, wallet.address, order.market, secret);
    // From here the order may be on the venue: it counts as sent, and the
    // market stays held, in storage too, until a result proves otherwise.
    const hold: UnknownHold = {
      market: order.market,
      side: order.side,
      type: order.type,
      size: order.size,
      price: order.price,
      tag: bytesToHex(secret),
      sentAtMs: this.now(),
      orderExpiresAtMs: expiry === undefined ? null : Number(expiry) * 1000,
    };
    if (!this.holdOrder(wallet, hold)) {
      untrackSecret(this.storage, wallet.address, secret);
      throw new Error("Could not record this order on this device first, so it was not sent.");
    }
    let result: PlaceOrderResult | null = null;
    let placed: Placed | null = null;
    let refusal: number | null = null;
    try {
      placed = await session.client.placeOrder(
        binding.numericId,
        {
          side: SIDE_CODE[order.side],
          orderType: ORDER_TYPE_CODE[wireOrderType(order.type, makersListedNow, order.reduceOnly)],
          price,
          size,
          reduceOnly: !!order.reduceOnly,
          expiry,
          secret,
        },
        { expirySeconds: DEFAULT_EXPIRY_SECONDS, pushWaitMs: RESULT_PUSH_WAIT_MS },
      );
    } catch (error) {
      // OrderInvalid (refused before signing), TransactionFailed (landed
      // and refused), or every order-key slot busy: all map to the
      // ordinary rejected state, like a book-dependent refusal, rather
      // than reaching the submit button's generic error path.
      // OutcomeUnknown (sent, and may still run) becomes a pending result.
      const mapped =
        thrownToResult(error, refusalContext) ??
        placeUnknownToResult(
          error,
          binding.units,
          binding.sizeDecimals,
          expiresAtMs,
          refusalContext,
        );
      // The package wraps every failure after its send begins in
      // `OutcomeUnknown` or `TransactionFailed`. Anything else it throws
      // (a market or blockhash read, a refused signature, no connection)
      // came before the transaction left, so nothing is held for it.
      if (!mapped) untrackSecret(this.storage, wallet.address, secret);
      refusal = refusalNumberOf(error);
      this.releaseUnknownOutcome(wallet, order.market);
      result = mapped ?? {
        orderId: "",
        tag: "",
        status: "rejected",
        filledSize: "0",
        remainingSize: "0",
        reason: NOT_SENT_REASON,
      };
    }
    if (placed) {
      // The order ran: failing to read its result back leaves the market held.
      try {
        result = placedToResult(
          placed,
          binding.units,
          binding.sizeDecimals,
          expiresAtMs,
          refusalContext,
        );
        if (placed.outcome !== "unknown") this.emitState(session, placed.view);
        if (placed.outcome === "placed") refusal = resultRefusalNumber(placed.result);
      } catch {
        throw new OrderOutcomeUnknownError(hold);
      }
      this.releaseUnknownOutcome(wallet, order.market);
    }
    if (!result) throw new OrderOutcomeUnknownError(hold);
    session.saveKeyCheckpoint();
    // `tag` is the handle the witness rail uses to find this order's own
    // fills (Terminal.tsx tracks it as `trackedTag`, matched against
    // `OwnFillRecord.tag`). Dev mode's tag is the venue-assigned number;
    // rollup mode has none, so the order's own secret (hex) plays the
    // same role here - `ownFills.ts` sets the exact same string on every
    // fill it derives for this secret.
    return { value: { ...result, tag: bytesToHex(secret) }, refusal };
  }

  /** The held order for this wallet and market: from memory, else from storage (a reload, a second tab). */
  private heldOrder(wallet: WalletIdentity, market: string): UnknownHold | null {
    return (
      this.unresolvedOrders.get(`${wallet.address}:${market}`) ??
      loadHolds(this.storage, wallet.address)[market] ??
      null
    );
  }

  /** False when the hold could not be written to storage: nothing is held then, and the order must not be sent. */
  private holdOrder(wallet: WalletIdentity, hold: UnknownHold): boolean {
    if (!saveHold(this.storage, wallet.address, hold)) return false;
    this.unresolvedOrders.set(`${wallet.address}:${hold.market}`, hold);
    return true;
  }

  async readUnknownOutcome(wallet: WalletIdentity, market: string): Promise<UnknownHold | null> {
    return this.heldOrder(wallet, market);
  }

  /** With a `tag`, releases only the hold that carries it: a record shown for another order or wallet never clears this one. */
  releaseUnknownOutcome(wallet: WalletIdentity, market: string, tag?: string): void {
    const held = this.heldOrder(wallet, market);
    if (tag !== undefined && held && held.tag !== tag) return;
    this.unresolvedOrders.delete(`${wallet.address}:${market}`);
    removeHold(this.storage, wallet.address, market);
  }

  async cancelOrder(
    wallet: WalletIdentity,
    market: string,
    orderId: string,
  ): Promise<CancelResult> {
    return this.withSession(wallet, async (session) => {
      const binding = this.bindings(session).get(market);
      if (!binding) throw new Error(`${market} was not found on chain`);
      const expiresAtMs = this.now() + DEFAULT_EXPIRY_SECONDS * 1000;
      const attempt = await this.runWithKeyResync(
        session,
        async (): Promise<KeyedAttempt<CancelResult>> => {
          try {
            const result = await session.client.cancelOrder(
              binding.numericId,
              BigInt(orderId),
              DEFAULT_EXPIRY_SECONDS,
            );
            session.saveKeyCheckpoint();
            return { value: cancelToResult(result), refusal: resultRefusalNumber(result) };
          } catch (error) {
            const mapped = cancelErrorToResult(error, expiresAtMs);
            if (!mapped) throw error;
            return { value: mapped, refusal: refusalNumberOf(error) };
          }
        },
        (result) => ({ ...result, reason: KEYS_IN_USE_ELSEWHERE_REASON }),
      );
      return attempt.value;
    });
  }

  async cancelAllInMarket(wallet: WalletIdentity, market: string): Promise<CancelResult> {
    return this.withSession(wallet, async (session) => {
      const binding = this.bindings(session).get(market);
      if (!binding) throw new Error(`${market} was not found on chain`);
      const expiresAtMs = this.now() + DEFAULT_EXPIRY_SECONDS * 1000;
      const attempt = await this.runWithKeyResync(
        session,
        async (): Promise<KeyedAttempt<CancelResult>> => {
          try {
            const result = await session.client.cancelAll(
              binding.numericId,
              DEFAULT_EXPIRY_SECONDS,
            );
            session.saveKeyCheckpoint();
            return { value: cancelToResult(result), refusal: resultRefusalNumber(result) };
          } catch (error) {
            const mapped = cancelErrorToResult(error, expiresAtMs);
            if (!mapped) throw error;
            return { value: mapped, refusal: refusalNumberOf(error) };
          }
        },
        (result) => ({ ...result, reason: KEYS_IN_USE_ELSEWHERE_REASON }),
      );
      return attempt.value;
    });
  }

  async transferBetweenBalances(
    wallet: WalletIdentity,
    toSpot: boolean,
    amount: string,
  ): Promise<TransferResult> {
    return this.withSession(wallet, async (session) => {
      const spot = [...this.bindings(session).values()].find((binding) => !binding.isPerp);
      const quoteIndex = spot ? session.tokenIndexBySymbol.get(spot.quoteTokenSymbol) : undefined;
      if (!spot || quoteIndex === undefined) {
        return { kind: "error", message: "No spot market to transfer into." };
      }
      const expiresAtMs = this.now() + DEFAULT_EXPIRY_SECONDS * 1000;
      const attempt = await this.runWithKeyResync(
        session,
        async (): Promise<KeyedAttempt<TransferResult>> => {
          try {
            const result = await session.client.transferBetweenBalances(
              !toSpot,
              quoteIndex,
              amountToQuoteAtoms(amount),
              DEFAULT_EXPIRY_SECONDS,
            );
            session.saveKeyCheckpoint();
            return { value: { kind: "ok" }, refusal: resultRefusalNumber(result) };
          } catch (error) {
            const mapped = transferErrorToResult(error, expiresAtMs);
            return {
              value: mapped ?? {
                kind: "error",
                message: error instanceof Error ? error.message : "The venue refused the transfer.",
              },
              refusal: refusalNumberOf(error),
            };
          }
        },
        (): TransferResult => ({ kind: "error", message: KEYS_IN_USE_ELSEWHERE_REASON }),
      );
      return attempt.value;
    });
  }

  async syncMarket(wallet: WalletIdentity, market: string): Promise<void> {
    await this.withSession(wallet, async (session) => {
      const binding = this.bindings(session).get(market);
      if (!binding) return;
      try {
        await session.client.syncView(binding.numericId, DEFAULT_EXPIRY_SECONDS);
        session.saveKeyCheckpoint();
      } catch {
        // Best effort, same as before: an own fill's view sync is a
        // background nicety (the next trading instruction re-syncs it
        // regardless), so an unknown or busy-slots outcome here is not
        // worth surfacing to the trader.
      }
    });
  }

  /**
   * The concrete evidence behind "nobody but the program can read the book"
   * (DESIGN.md section 1): reads this trader's own view account and
   * `market`'s book account straight from the rollup's query filter, with
   * no sign-in token on this connection - the same unsigned read any
   * visitor could make - and reports whether each came back empty. A
   * private account read by a non-member returns nothing, which is exactly
   * what this demonstrates. The book's address is not in `/v1/deployment`
   * (DESIGN.md: a book is "the program only" readable, so there is no
   * reason to publish it) but is a deterministic PDA of programId +
   * marketId, computed here, not read from anywhere.
   */
  async checkPrivacy(wallet: WalletIdentity, market: string): Promise<PrivacyCheck> {
    return this.withSession(wallet, async (session) => {
      const binding = this.bindings(session).get(market);
      if (!binding) throw new Error(`${market} was not found on chain`);
      const addresses = programAddresses(new PublicKey(session.deployment.programId));
      const anonymous = connectionTo(
        session.deployment.rollupRpcUrl,
        session.deployment.rollupWsUrl,
      );
      const viewAddress = addresses.view(session.owner.publicKey);
      const bookAddress = addresses.book(binding.numericId);
      const [viewOutcome, bookOutcome] = await Promise.all([
        readAccountUnsigned(anonymous, viewAddress),
        readAccountUnsigned(anonymous, bookAddress),
      ]);
      return {
        network: session.deployment.network,
        checkedAtMs: Date.now(),
        endpoint: session.deployment.rollupRpcUrl,
        view: { address: viewAddress.toBase58(), outcome: viewOutcome },
        book: { address: bookAddress.toBase58(), outcome: bookOutcome },
      };
    });
  }

  async fetchState(wallet: WalletIdentity): Promise<TraderState> {
    return this.withSession(wallet, (session) => Promise.resolve(this.mapView(session)));
  }

  subscribe(
    wallet: WalletIdentity,
    listener: StateListener,
    onError?: (error: Error) => void,
  ): () => void {
    const listeners = this.listeners.get(wallet.address) ?? new Set();
    this.listeners.set(wallet.address, listeners);
    listeners.add(listener);
    const errorListeners = this.errorListeners.get(wallet.address) ?? new Set();
    this.errorListeners.set(wallet.address, errorListeners);
    if (onError) errorListeners.add(onError);
    void this.ensureSession(wallet).catch((error: unknown) =>
      onError?.(error instanceof Error ? error : new Error(String(error))),
    );
    return () => {
      listeners.delete(listener);
      if (onError) errorListeners.delete(onError);
    };
  }

  /** A read that comes back older than a view already shown yields that newer view instead, so a slow read never rolls the account back. */
  private mapView(session: RollupSession): Promise<TraderState> {
    return session.client.view().then((view) => {
      const held = this.lastViews.get(session.owner.publicKey.toBase58());
      return held && held.view.resultsWritten > view.resultsWritten
        ? this.mapViewFrom(held.session, held.view)
        : this.mapViewFrom(session, view);
    });
  }

  private mapViewFrom(session: RollupSession, view: View): TraderState {
    const address = session.owner.publicKey.toBase58();
    const held = this.lastViews.get(address);
    if (!held || view.resultsWritten >= held.view.resultsWritten) {
      this.lastViews.set(address, { session, view });
    }
    const bindings = this.bindings(session);
    const seat = view.snapshot.seat;

    const balances: Record<string, Balance> = {};
    for (const market of session.deployment.markets) {
      for (const token of [market.baseToken, market.quoteToken]) {
        if (!token || balances[token.symbol]) continue;
        const tokenIndex = session.tokenIndexBySymbol.get(token.symbol);
        const slot = tokenIndex !== undefined ? seat.spot[tokenIndex] : undefined;
        if (!slot) continue;
        const available = atomsToAmount(slot.available, token.decimals);
        const reserved = atomsToAmount(slot.locked, token.decimals);
        balances[token.symbol] = {
          asset: token.symbol,
          available,
          reserved,
          total: addDecimalStrings(available, reserved),
        };
      }
    }

    const positions: Record<string, Position> = {};
    const exposures: PerpExposure[] = [];
    const now = this.now();
    let marksFreshUntilMs: number | null = null;
    for (const market of session.deployment.markets) {
      if (market.kind !== "perp") continue;
      const slot = seat.perp[market.marketId];
      if (!slot) continue;
      const openBidLots = slot.openBidLots ?? 0n;
      const openAskLots = slot.openAskLots ?? 0n;
      const hasExposure = slot.base !== 0n || openBidLots !== 0n || openAskLots !== 0n;
      const binding = bindings.get(market.symbol);
      if (!binding) {
        // A slot that cannot be bound cannot be priced: with a position or
        // resting orders in it, the margin is unknown rather than guessed.
        if (hasExposure) {
          exposures.push({
            baseLots: slot.base,
            quoteAtoms: slot.quote,
            openBidLots,
            openAskLots,
            sizePerLot: 0n,
            mark: null,
            maxLeverage: 0,
          });
        }
        continue;
      }
      const settings = this.options.marketSettingsLookup(binding.marketId);
      const freshMark =
        settings?.markPrice != null && !isStale(settings.markPriceUpdatedAtMs, now, STALE_MARK_MS)
          ? settings.markPrice
          : null;
      if (hasExposure && freshMark !== null && settings?.markPriceUpdatedAtMs != null) {
        const staleAtMs = settings.markPriceUpdatedAtMs + STALE_MARK_MS;
        marksFreshUntilMs =
          marksFreshUntilMs === null ? staleAtMs : Math.min(marksFreshUntilMs, staleAtMs);
      }
      exposures.push({
        baseLots: slot.base,
        quoteAtoms: slot.quote,
        openBidLots,
        openAskLots,
        sizePerLot: binding.units.sizePerLot,
        mark: freshMark,
        maxLeverage: settings?.maxLeverage ?? 0,
      });
      if (slot.base === 0n) continue;
      const entryPrice =
        slot.base === 0n
          ? "0"
          : chainAtomsToPrice(
              binding.units,
              absBigint(slot.quote) / absBigint(slot.base),
              binding.priceDecimals,
            );
      positions[binding.marketId] = {
        market: binding.marketId,
        size: lotsToSize(binding.units, slot.base, binding.sizeDecimals),
        entryPrice,
        quote: quoteAtomsToAmount(slot.quote),
        maintenanceMarginBps: session.maintenanceMarginBps?.get(binding.numericId),
      };
    }

    const margin = summarizeMargin(seat.collateral, exposures);
    const collateral: Balance = {
      asset: quoteSymbolOf(session.deployment) ?? "",
      available: margin.kind === "known" ? quoteAtomsToAmount(margin.available) : "0",
      reserved: margin.kind === "known" ? quoteAtomsToAmount(margin.reserved) : "0",
      total: quoteAtomsToAmount(seat.collateral),
      ...(margin.kind === "unknown" ? { availableUnknown: true } : {}),
      ...(margin.kind === "known"
        ? {
            transferable: quoteAtomsToAmount(
              margin.available < seat.collateral ? margin.available : seat.collateral,
            ),
          }
        : {}),
      ...(margin.kind === "known" && marksFreshUntilMs !== null
        ? { availableValidUntilMs: marksFreshUntilMs }
        : {}),
    };

    const openOrders = this.restingOrders(session.owner.publicKey.toBase58(), view, bindings);

    return {
      trader: session.owner.publicKey.toBase58(),
      equity: margin.kind === "known" ? quoteAtomsToAmount(margin.equity) : null,
      balances,
      collateral,
      positions,
      openOrders,
      spotAssets: spotAssetsOf(session.deployment),
    };
  }

  /**
   * A view carries the order list of ONE market (`snapshot.marketId`, the
   * market the last instruction targeted), but every perp slot carries its
   * resting bid and ask lots. Orders last read for a perp market stay listed
   * only while those lots still match what was read, so an order that has
   * since filled or been cancelled elsewhere is dropped, never shown stale.
   * A spot market's orders show only while it is the snapshot market.
   */
  private restingOrders(
    address: string,
    view: View,
    bindings: Map<string, MarketBinding>,
  ): OpenOrder[] {
    const seen = this.restingByMarket.get(address) ?? new Map<number, RestingRead>();
    this.restingByMarket.set(address, seen);
    const { seat, orders, marketId } = view.snapshot;
    const snapshotBinding = bindingByNumericId(bindings, marketId);
    const mapOrders = (binding: MarketBinding): OpenOrder[] =>
      orders.map((order) => ({
        orderId: order.sequence.toString(),
        tag: "",
        market: binding.marketId,
        side: order.side === 0 ? "buy" : "sell",
        type: "limit",
        price: chainAtomsToPrice(binding.units, order.price, binding.priceDecimals),
        size: lotsToSize(binding.units, order.remaining, binding.sizeDecimals),
        remainingSize: lotsToSize(binding.units, order.remaining, binding.sizeDecimals),
        // The view's order record has no reduce-only flag; the venue keeps it off-view.
        reduceOnly: false,
      }));

    if (snapshotBinding?.isPerp) {
      const slot = seat.perp[snapshotBinding.numericId];
      seen.set(snapshotBinding.numericId, {
        orders: mapOrders(snapshotBinding),
        bidLots: slot?.openBidLots ?? 0n,
        askLots: slot?.openAskLots ?? 0n,
      });
    }

    const listed: OpenOrder[] = [];
    for (const binding of bindings.values()) {
      if (!binding.isPerp) continue;
      const read = seen.get(binding.numericId);
      const slot = seat.perp[binding.numericId];
      const unchanged =
        read &&
        (binding === snapshotBinding ||
          (slot &&
            read.bidLots === (slot.openBidLots ?? 0n) &&
            read.askLots === (slot.openAskLots ?? 0n)));
      if (!unchanged) {
        seen.delete(binding.numericId);
        continue;
      }
      listed.push(...read.orders);
    }
    if (snapshotBinding && !snapshotBinding.isPerp) listed.push(...mapOrders(snapshotBinding));
    return listed;
  }
}

function expiryFor(goodFor: NewOrderInput["goodFor"], now: () => number): bigint | undefined {
  if (!goodFor || goodFor === "untilCancelled") return undefined;
  return BigInt(Math.floor(now() / 1000)) + GOOD_FOR_SECONDS[goodFor];
}

function spotAssetsOf(deployment: PublicDeployment): Record<string, SpotAssets> {
  const assets: Record<string, SpotAssets> = {};
  for (const market of deployment.markets) {
    if (!market.baseToken) continue;
    assets[market.symbol] = { base: market.baseToken.symbol, quote: market.quoteToken.symbol };
  }
  return assets;
}

function absBigint(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function atomsToAmount(atoms: bigint, decimals: number): string {
  const sixDecimalAtoms =
    decimals >= 6 ? atoms / 10n ** BigInt(decimals - 6) : atoms * 10n ** BigInt(6 - decimals);
  return quoteAtomsToAmount(sixDecimalAtoms);
}

function addDecimalStrings(a: string, b: string): string {
  const av = Number(a);
  const bv = Number(b);
  return Number.isFinite(av) && Number.isFinite(bv) ? (av + bv).toFixed(6) : a;
}
