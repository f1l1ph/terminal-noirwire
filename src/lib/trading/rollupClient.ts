import { PublicKey, type Connection } from "@solana/web3.js";
import { browserLocalStorage, bytesToHex, type KeyValueStore } from "../wallet/index";
import { signChecked } from "../rollup/ownerSend";
import { isExpectedOpen, prepareOpen, submitOpen, type OpenRefusal } from "../rollup/openClient";
import { orderSeedPersisted } from "../rollup/orderSeedStore";
import type { OrderKeyStatus } from "../rollup/orderKeySetup";
import { redactToken, scrubError } from "../rollup/redact";
import { TOKEN_REFRESH_MARGIN_MS } from "../rollup/signInToken";
import {
  quoteSymbolOf,
  type DeploymentOverrides,
  type PublicDeployment,
} from "../rollup/deployment";
import { openAndFund } from "../rollup/fundingClient";
import {
  cancelErrorToResult,
  cancelToResult,
  placedToResult,
  placeUnknownToResult,
  thrownToResult,
  transferErrorToResult,
} from "../rollup/outcome";
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
  SessionAuthError,
  trustedProgramId,
  type RollupSession,
  type RollupSessionDeps,
} from "../rollup/session";
import {
  connectionTo,
  ORDER_TYPE_CODE,
  programAddresses,
  SIDE_CODE,
  randomSecret,
  VIEW_NOT_READABLE_MESSAGE,
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
import type {
  AccountReadOutcome,
  AccountStatus,
  Balance,
  CancelResult,
  FundOutcome,
  MarketSettingsLookup,
  NewOrderInput,
  OpenAccountOutcome,
  OpenOrder,
  OrderKeyState,
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
  private ensureSession(wallet: WalletIdentity): Promise<RollupSession> {
    const existing = this.sessions.get(wallet.address);
    if (existing && existing.signer !== wallet.signer) return this.refreshSession(wallet);
    return (existing ?? this.openSession(wallet)).session;
  }

  private refreshSession(wallet: WalletIdentity): Promise<RollupSession> {
    const previous = this.sessions.get(wallet.address);
    const { session } = this.openSession(wallet);
    if (previous) closeSession(previous);
    return session;
  }

  private openSession(wallet: WalletIdentity): OpenSession {
    const session = this.buildSession(wallet, this.sessionDeps(wallet));
    const opened = {
      session,
      signer: wallet.signer,
      stopWatching: session.then((built) => this.watchView(built)),
    };
    opened.stopWatching.catch(() => {});
    this.sessions.set(wallet.address, opened);
    // A build that failed is not kept as this wallet's session: the next
    // call builds again rather than rejecting until the wallet is closed.
    session.catch(() => {
      if (this.sessions.get(wallet.address) === opened) this.sessions.delete(wallet.address);
    });
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

  /** Ends this wallet's session (its live subscription and background refreshes), if one is open. */
  closeWallet(wallet: WalletIdentity): void {
    this.lastOrderKeys.delete(wallet.address);
    const existing = this.sessions.get(wallet.address);
    if (!existing) return;
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
    let session: RollupSession;
    try {
      session = await this.ensureSession(wallet);
    } catch (error) {
      if (!(error instanceof SessionAuthError)) throw error;
      session = await this.refreshSession(wallet);
    }
    if (session.tokenExpiresAtMs - this.now() < TOKEN_REFRESH_MARGIN_MS) {
      session = await this.refreshSession(wallet);
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

  async accountStatus(wallet: WalletIdentity): Promise<AccountStatus> {
    try {
      return await this.withSession(wallet, (session) => this.viewStatus(session));
    } catch {
      return "unknown";
    }
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
      const reason = error instanceof Error ? error.message : "the account could not be opened";
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
      const binding = this.bindings(session).get(order.market);
      if (!binding) throw new Error(`${order.market} was not found on chain`);
      const price = priceToChainAtoms(binding.units, order.price);
      const size = sizeToLots(binding.units, order.size);
      const secret = randomSecret();
      const expiry = expiryFor(order.goodFor, this.now);
      const expiresAtMs = this.now() + DEFAULT_EXPIRY_SECONDS * 1000;
      const refusalContext = {
        maxPriceAgeSeconds: session.maxPriceAgeSeconds?.get(binding.numericId),
        isPerp: binding.isPerp,
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
      let result: PlaceOrderResult;
      try {
        const placed = await session.client.placeOrder(
          binding.numericId,
          {
            side: SIDE_CODE[order.side],
            orderType: ORDER_TYPE_CODE[order.type],
            price,
            size,
            reduceOnly: !!order.reduceOnly,
            expiry,
            secret,
          },
          { expirySeconds: DEFAULT_EXPIRY_SECONDS, pushWaitMs: RESULT_PUSH_WAIT_MS },
        );
        this.releaseUnknownOutcome(wallet, order.market);
        result = placedToResult(
          placed,
          binding.units,
          binding.sizeDecimals,
          expiresAtMs,
          refusalContext,
        );
        if (placed.outcome !== "unknown") this.emitState(session, placed.view);
      } catch (error) {
        // OrderInvalid (refused before signing), TransactionFailed (landed
        // and refused), or every order-key slot busy: all map to the
        // ordinary rejected state, like a book-dependent refusal, rather
        // than reaching the submit button's generic error path.
        // OutcomeUnknown (sent, and may still run) becomes a pending result.
        // Whatever is left is not proven to have happened before the send,
        // whatever its text says, so it is never retried.
        const mapped =
          thrownToResult(error, refusalContext) ??
          placeUnknownToResult(
            error,
            binding.units,
            binding.sizeDecimals,
            expiresAtMs,
            refusalContext,
          );
        if (!mapped) throw new OrderOutcomeUnknownError(hold);
        this.releaseUnknownOutcome(wallet, order.market);
        result = mapped;
      }
      session.saveKeyCheckpoint();
      // `tag` is the handle the witness rail uses to find this order's own
      // fills (Terminal.tsx tracks it as `trackedTag`, matched against
      // `OwnFillRecord.tag`). Dev mode's tag is the venue-assigned number;
      // rollup mode has none, so the order's own secret (hex) plays the
      // same role here - `ownFills.ts` sets the exact same string on every
      // fill it derives for this secret.
      return { ...result, tag: bytesToHex(secret) };
    });
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
      try {
        const result = await session.client.cancelOrder(
          binding.numericId,
          BigInt(orderId),
          DEFAULT_EXPIRY_SECONDS,
        );
        session.saveKeyCheckpoint();
        return cancelToResult(result);
      } catch (error) {
        const mapped = cancelErrorToResult(error, expiresAtMs);
        if (!mapped) throw error;
        return mapped;
      }
    });
  }

  async cancelAllInMarket(wallet: WalletIdentity, market: string): Promise<CancelResult> {
    return this.withSession(wallet, async (session) => {
      const binding = this.bindings(session).get(market);
      if (!binding) throw new Error(`${market} was not found on chain`);
      const expiresAtMs = this.now() + DEFAULT_EXPIRY_SECONDS * 1000;
      try {
        const result = await session.client.cancelAll(binding.numericId, DEFAULT_EXPIRY_SECONDS);
        session.saveKeyCheckpoint();
        return cancelToResult(result);
      } catch (error) {
        const mapped = cancelErrorToResult(error, expiresAtMs);
        if (!mapped) throw error;
        return mapped;
      }
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
      try {
        await session.client.transferBetweenBalances(
          !toSpot,
          quoteIndex,
          amountToQuoteAtoms(amount),
          DEFAULT_EXPIRY_SECONDS,
        );
        session.saveKeyCheckpoint();
        return { kind: "ok" };
      } catch (error) {
        const mapped = transferErrorToResult(error, expiresAtMs);
        if (mapped) return mapped;
        return {
          kind: "error",
          message: error instanceof Error ? error.message : "The venue refused the transfer.",
        };
      }
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

  private mapView(session: RollupSession): Promise<TraderState> {
    return session.client.view().then((view) => this.mapViewFrom(session, view));
  }

  private mapViewFrom(session: RollupSession, view: View): TraderState {
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
