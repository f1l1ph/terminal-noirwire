import { PublicKey, type Connection } from "@solana/web3.js";
import {
  browserLocalStorage,
  bytesToHex,
  type KeyValueStore,
  type WalletAccount,
} from "../wallet/index";
import type { DeploymentOverrides } from "../rollup/deployment";
import { openAndFund } from "../rollup/fundingClient";
import {
  cancelErrorToResult,
  cancelToResult,
  placedToResult,
  thrownToResult,
  transferErrorToResult,
} from "../rollup/outcome";
import { trackSecret } from "../rollup/secretStore";
import { buildRealSession, type RollupSession, type RollupSessionDeps } from "../rollup/session";
import {
  connectionTo,
  ORDER_TYPE_CODE,
  programAddresses,
  SIDE_CODE,
  randomSecret,
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
import type {
  AccountReadOutcome,
  Balance,
  CancelResult,
  FundOutcome,
  MarketSettingsLookup,
  NewOrderInput,
  OpenOrder,
  PlaceOrderResult,
  Position,
  PrivacyCheck,
  TraderState,
  TradingClient,
  TransferResult,
  WalletIdentity,
} from "./types";

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

const DEFAULT_POLL_INTERVAL_MS = 1_000;
/**
 * Conservative: the rollup's sign-in token lifetime is not stated by
 * `@noirwire/orderbook` (`signIn`/`privateConnection` return a token with no
 * exposed expiry), so this refreshes well inside any plausible TTL rather
 * than waiting to be rejected. See docs/BUILD-NOTES.md.
 */
const SESSION_REFRESH_MS = 4 * 60 * 1000;
const GOOD_FOR_SECONDS: Record<"1m" | "1h", bigint> = { "1m": 60n, "1h": 3_600n };
/**
 * Passed explicitly on every keyed call (place/cancel/transfer/sync) so this
 * client can compute `PendingSettlement.expiresAtMs` itself from the same
 * value and the same wall clock the package uses internally (`Date.now()`),
 * rather than mirroring the package's own default (also 5s) and risking it
 * drifting out of sync with a future release.
 */
const DEFAULT_EXPIRY_SECONDS = 5;

export interface RollupTradingClientOptions {
  simUrl: string;
  /** Overrides for `/v1/deployment`'s URLs/program id - a container or a hosted deployment reaching the network at an address the browser cannot. */
  overrides?: DeploymentOverrides;
  marketSettingsLookup: MarketSettingsLookup;
  storage?: KeyValueStore;
  fetchFn?: typeof fetch;
  pollIntervalMs?: number;
  setIntervalFn?: (handler: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  now?: () => number;
  /** Testability seam: a fake session (and so a fake of the package's client) for unit tests. Builds a real one by default. */
  buildSession?: (wallet: WalletAccount, deps: RollupSessionDeps) => Promise<RollupSession>;
}

/** This terminal's string market id, bound against `/v1/deployment`'s numeric one. */
interface MarketBinding {
  marketId: string;
  numericId: number;
  units: MarketUnits;
  sizeDecimals: number;
  priceDecimals: number;
  isPerp: boolean;
  baseTokenSymbol: string | null;
  quoteTokenSymbol: string;
}

function ownerSecretOf(wallet: WalletIdentity): WalletAccount {
  if (!wallet.secretKeyHex) {
    throw new Error(
      "This trading client needs the wallet's secret key (rollup mode signs locally)",
    );
  }
  return { publicKey: wallet.address, secretKeyHex: wallet.secretKeyHex };
}

/**
 * Every `/v1/deployment` market this terminal's `marketSettingsLookup` also
 * knows about, matched by its string symbol (identical on both sides - no
 * base/quote/kind matching needed now that the deployment names markets by
 * the same id `/v1/markets` uses).
 */
function bindMarkets(
  session: RollupSession,
  marketSettingsLookup: MarketSettingsLookup,
): Map<string, MarketBinding> {
  const bindings = new Map<string, MarketBinding>();
  for (const market of session.deployment.markets) {
    const settings = marketSettingsLookup(market.symbol);
    if (!settings) continue;
    bindings.set(market.symbol, {
      marketId: market.symbol,
      numericId: market.marketId,
      units: marketUnitsFromChain(BigInt(market.lotSize), market.baseDecimals),
      sizeDecimals: sizeDecimalsOf(settings),
      priceDecimals: priceDecimalsOf(settings),
      isPerp: market.kind === "perp",
      baseTokenSymbol: market.baseToken?.symbol ?? null,
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

function riskMarketIds(bindings: Map<string, MarketBinding>): number[] {
  const ids: number[] = [];
  for (const binding of bindings.values()) {
    if (binding.isPerp) ids.push(binding.numericId);
  }
  return ids;
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
  private readonly pollIntervalMs: number;
  private readonly setIntervalFn: (handler: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private readonly now: () => number;
  private readonly buildSession: (
    wallet: WalletAccount,
    deps: RollupSessionDeps,
  ) => Promise<RollupSession>;
  private sessions = new Map<string, Promise<RollupSession>>();

  constructor(private readonly options: RollupTradingClientOptions) {
    this.storage = options.storage ?? browserLocalStorage();
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.setIntervalFn = options.setIntervalFn ?? ((handler, ms) => setInterval(handler, ms));
    this.clearIntervalFn = options.clearIntervalFn ?? ((handle) => clearInterval(handle as number));
    this.now = options.now ?? (() => Date.now());
    this.buildSession = options.buildSession ?? buildRealSession;
  }

  private sessionDeps(): RollupSessionDeps {
    return {
      simUrl: this.options.simUrl,
      overrides: this.options.overrides,
      fetchFn: this.fetchFn,
      now: this.now,
    };
  }

  private async ensureSession(wallet: WalletIdentity): Promise<RollupSession> {
    const existing = this.sessions.get(wallet.address);
    if (existing) return existing;
    const promise = this.buildSession(ownerSecretOf(wallet), this.sessionDeps());
    this.sessions.set(wallet.address, promise);
    return promise;
  }

  private async refreshSession(wallet: WalletIdentity): Promise<RollupSession> {
    // The session being replaced may still hold a live subscription; close
    // it before it is forgotten so it does not linger as an orphaned
    // websocket alongside the new one.
    const previous = this.sessions.get(wallet.address);
    const promise = this.buildSession(ownerSecretOf(wallet), this.sessionDeps());
    this.sessions.set(wallet.address, promise);
    if (previous) void previous.then((session) => session.close()).catch(() => {});
    return promise;
  }

  /** Ends this wallet's session (its live subscription and background refreshes), if one is open. */
  closeWallet(wallet: WalletIdentity): void {
    const existing = this.sessions.get(wallet.address);
    if (!existing) return;
    this.sessions.delete(wallet.address);
    void existing.then((session) => session.close()).catch(() => {});
  }

  /**
   * Runs `fn` against this wallet's session, refreshing the sign-in and
   * retrying once if the session is older than `SESSION_REFRESH_MS` or the
   * call itself throws. An expired token surfaces as a thrown error from
   * the private connection, not a typed result, so any failure gets one
   * retry against a fresh sign-in rather than trying to recognise the exact
   * shape of an auth error ourselves.
   */
  private async withSession<T>(
    wallet: WalletIdentity,
    fn: (session: RollupSession) => Promise<T>,
  ): Promise<T> {
    let session = await this.ensureSession(wallet);
    if (this.now() - session.createdAtMs > SESSION_REFRESH_MS) {
      session = await this.refreshSession(wallet);
    }
    try {
      return await fn(session);
    } catch {
      session = await this.refreshSession(wallet);
      return fn(session);
    }
  }

  private bindings(session: RollupSession): Map<string, MarketBinding> {
    return bindMarkets(session, this.options.marketSettingsLookup);
  }

  async openAccount(wallet: WalletIdentity): Promise<void> {
    // Nothing to do ahead of funding: there is no bare "open without
    // funding" route, and deriving the owner/order keys (ensureSession) has
    // no network cost worth doing eagerly. See `fund()`.
    try {
      await this.ensureSession(wallet);
    } catch {
      // Best effort, matching DevTradingClient.openAccount.
    }
  }

  async fund(wallet: WalletIdentity): Promise<FundOutcome> {
    const session = await this.ensureSession(wallet);
    try {
      await session.client.view();
      return { kind: "alreadyFunded" };
    } catch {
      // No view yet: account is not open. Fall through to open + fund.
    }
    const outcome = await openAndFund(
      this.options.simUrl,
      session.owner,
      session.orderKeyPublicKeys,
      this.fetchFn,
    );
    if (outcome.kind === "granted") {
      // The session's client was built before the account existed, so its
      // reader may not yet see the view; a fresh session re-establishes it
      // cleanly rather than guessing whether a retry is needed.
      const funded = await this.refreshSession(wallet);
      // The deposit instruction credits the ledger's seat directly; it does
      // not touch the TraderView (only an order-key-signed instruction
      // does, as a side effect of its own seat copy). Without this, the
      // dashboard would show 0 available until the trader's first order.
      const anyMarket = funded.deployment.markets[0];
      if (anyMarket) {
        try {
          await funded.client.syncView(anyMarket.marketId);
          funded.saveKeyCheckpoint();
        } catch {
          // Best effort: the first trade's own instruction will refresh the
          // view regardless, and the belt-and-braces poll will catch up too.
        }
      }
    }
    return outcome;
  }

  async placeOrder(wallet: WalletIdentity, order: NewOrderInput): Promise<PlaceOrderResult> {
    return this.withSession(wallet, async (session) => {
      const bindings = this.bindings(session);
      const binding = bindings.get(order.market);
      if (!binding) throw new Error(`${order.market} was not found on chain`);
      const price = priceToChainAtoms(binding.units, order.price);
      const size = sizeToLots(binding.units, order.size);
      const secret = randomSecret();
      const expiry = expiryFor(order.goodFor, this.now);
      const expiresAtMs = this.now() + DEFAULT_EXPIRY_SECONDS * 1000;
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
          {
            expirySeconds: DEFAULT_EXPIRY_SECONDS,
            riskMarkets: binding.isPerp ? riskMarketIds(bindings) : undefined,
          },
        );
        result = placedToResult(placed, binding.units, binding.sizeDecimals, expiresAtMs);
      } catch (error) {
        // OrderInvalid (refused before signing), TransactionFailed (landed
        // and refused), or every order-key slot busy: all map to the
        // ordinary rejected state, like a book-dependent refusal, rather
        // than reaching the submit button's generic error path.
        const mapped = thrownToResult(error);
        if (!mapped) throw error;
        result = mapped;
      }
      session.saveKeyCheckpoint();
      trackSecret(this.storage, wallet.address, order.market, secret);
      // `tag` is the handle the witness rail uses to find this order's own
      // fills (Terminal.tsx tracks it as `trackedTag`, matched against
      // `OwnFillRecord.tag`). Dev mode's tag is the venue-assigned number;
      // rollup mode has none, so the order's own secret (hex) plays the
      // same role here - `ownFills.ts` sets the exact same string on every
      // fill it derives for this secret.
      return { ...result, tag: bytesToHex(secret) };
    });
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
      const bindings = this.bindings(session);
      const spot = [...bindings.values()].find((binding) => !binding.isPerp);
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
          riskMarketIds(bindings),
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

  subscribe(wallet: WalletIdentity, listener: (state: TraderState) => void): () => void {
    let cancelled = false;
    let unsubscribeView: (() => Promise<void>) | null = null;

    const attach = async () => {
      const session = await this.ensureSession(wallet);
      if (cancelled) return;
      const emit = (view: View) => {
        if (!cancelled) listener(this.mapViewFrom(session, view));
      };
      try {
        emit(await session.client.view());
      } catch {
        // No view yet (account not open); the subscription below still
        // attaches so a later open+fund is picked up by the push channel.
      }
      unsubscribeView = session.client.subscribeView(emit);
    };
    void attach();

    // A belt-and-braces poll, much slower than dev mode's: subscribeView
    // above is the primary channel (push, on every account change); this
    // only guards against a missed notification or a session refresh.
    const refreshHandle = this.setIntervalFn(() => {
      void this.fetchState(wallet).then((state) => {
        if (!cancelled) listener(state);
      });
    }, this.pollIntervalMs * 5);

    return () => {
      cancelled = true;
      this.clearIntervalFn(refreshHandle);
      void unsubscribeView?.();
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
    for (const binding of bindings.values()) {
      if (!binding.isPerp) continue;
      const slot = seat.perp[binding.numericId];
      if (!slot || slot.base === 0n) continue;
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

    const collateral: Balance = {
      asset: "nUSD",
      available: quoteAtomsToAmount(seat.collateral > 0n ? seat.collateral : 0n),
      reserved: "0",
      total: quoteAtomsToAmount(seat.collateral),
    };

    // RULES.md / accounts.ts: a trader's view carries open orders for ONE
    // market at a time (`snapshot.marketId`), the market the last trading
    // instruction targeted - not every market at once the way dev mode's
    // `/v1/dev/trader` does. See docs/BUILD-NOTES.md for this limitation.
    const snapshotBinding = bindingByNumericId(bindings, view.snapshot.marketId);
    const openOrders: OpenOrder[] = snapshotBinding
      ? view.snapshot.orders.map((order) => ({
          orderId: order.sequence.toString(),
          tag: "",
          market: snapshotBinding.marketId,
          side: order.side === 0 ? "buy" : "sell",
          type: "limit",
          price: chainAtomsToPrice(
            snapshotBinding.units,
            order.price,
            snapshotBinding.priceDecimals,
          ),
          size: lotsToSize(snapshotBinding.units, order.remaining, snapshotBinding.sizeDecimals),
          remainingSize: lotsToSize(
            snapshotBinding.units,
            order.remaining,
            snapshotBinding.sizeDecimals,
          ),
          reduceOnly: false,
        }))
      : [];

    return {
      trader: session.owner.publicKey.toBase58(),
      equity: quoteAtomsToAmount(seat.collateral),
      balances,
      collateral,
      positions,
      openOrders,
    };
  }
}

function expiryFor(goodFor: NewOrderInput["goodFor"], now: () => number): bigint | undefined {
  if (!goodFor || goodFor === "untilCancelled") return undefined;
  return BigInt(Math.floor(now() / 1000)) + GOOD_FOR_SECONDS[goodFor];
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
