import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { isMainnetBuild } from "../network";
import type { WalletIdentity } from "../trading/types";
import { browserLocalStorage } from "../wallet/index";
import { StaleSigner, type OwnerSigner } from "../wallet/ownerSigner";
import { NetworkRefused } from "./networkCheck";
import { secretOwner, type DerivedOrderSeeds } from "../wallet/secretSigner";
import { loadCheckpoint, saveCheckpoint } from "./checkpointStore";
import { assertRollupIdentity } from "./identity";
import {
  fetchDeployment,
  usesOwnerMessages,
  type DeploymentOverrides,
  type PublicDeployment,
} from "./deployment";
import { installOrderKeysSigned } from "./ownerMessages";
import { isMainnetOwnerSigner } from "./mainnetOwner";
import { marketMatchesChain } from "./markets";
import { deviceOrderKeys, type DeviceSeeds, type OrderKeyStatus } from "./orderKeySetup";
import { loadOrderSeed, createOrderSeed } from "./orderSeedStore";
import { clearSignInToken, signedInReader, type SignedIn } from "./signInToken";
import { redactToken, scrubError } from "./redact";
import {
  checkpointOf,
  connectionTo,
  connectWithToken,
  decodeExchangeAccount,
  decodeMarketAccount,
  freshOrderKeys,
  installOrderKeys,
  isMakersListed,
  KEYS_NOT_FROM_SEED_MESSAGE,
  orderKeyPublicKeys,
  orderKeysFromCheckpoint,
  PACKAGE_PROGRAM_ID,
  programAddresses,
  signInWithExpiry,
  TraderClient,
  VIEW_NOT_READABLE_MESSAGE,
  viewKeysDeriveFrom,
  type CustodyToken,
  type OrderKeyManager,
  type OrderResult,
  type Placed,
  type Timing,
  type View,
  type Withdrawn,
} from "./sdk";

/** The slice of `./sdk`'s `TraderClient` this module needs; a fake of this shape is what unit tests inject. */
export interface TraderClientLike {
  view(): Promise<View>;
  subscribeView(onChange: (view: View) => void): () => Promise<void>;
  /** Optional: only the real SDK client (0.5.0+) has these; a unit-test fake may omit them. */
  ready?(): Promise<void>;
  close?(): void;
  placeOrder(
    marketId: number,
    order: {
      side: number;
      orderType: number;
      price: bigint;
      size: bigint;
      reduceOnly: boolean;
      expiry?: bigint;
      secret?: Uint8Array;
    },
    options?: { expirySeconds?: number; pushWaitMs?: number },
  ): Promise<Placed>;
  /** May throw `OutcomeUnknown` (carries `settled`) instead of returning; see `./sdk.ts`. */
  cancelOrder(
    marketId: number,
    orderSeq: bigint,
    expirySeconds?: number,
  ): Promise<OrderResult & Timing>;
  cancelAll(marketId: number, expirySeconds?: number): Promise<OrderResult & Timing>;
  syncView(marketId: number, expirySeconds?: number): Promise<OrderResult & Timing>;
  /** Optional: only the real SDK client (0.8.0+) has it; a unit-test fake may omit it. */
  withdrawByKey?(token: CustodyToken, amount: bigint, expirySeconds?: number): Promise<Withdrawn>;
  transferBetweenBalances(
    toCollateral: boolean,
    spotToken: number,
    amount: bigint,
    expirySeconds?: number,
  ): Promise<OrderResult & Timing>;
}

export interface RollupSession {
  /** The owner's signer port; the session never holds the owner key itself. */
  owner: OwnerSigner;
  orderKeyPublicKeys: string[];
  client: TraderClientLike;
  deployment: PublicDeployment;
  /** Token symbol -> its index in `Seat.spot[]`, resolved once from the Exchange account (not a market-by-market scan). */
  tokenIndexBySymbol: Map<string, number>;
  /** The rollup connection signed in as the owner, which the transfers read the owner's rollup token account through. A test fake may omit it. */
  reader?: Connection;
  /** The Exchange's collateral token, read from the Exchange account: every funding deposit must name exactly its custody. */
  collateralToken: CustodyToken;
  /** The gate that pays for opening an account, read from the Exchange account and never from the service. */
  gate: PublicKey;
  /** Market id -> the oldest mark, in seconds, its account accepts an order against (`maxPriceAge`). A test fake may omit it. */
  maxPriceAgeSeconds?: ReadonlyMap<number, number>;
  /** Market id -> its account's maintenance margin ratio in basis points, which decides when a position is liquidated. A test fake may omit it. */
  maintenanceMarginBps?: ReadonlyMap<number, number>;
  /** Ids of the markets whose account had the maker list switched on when this session was built. A test fake may omit it. */
  makersListed?: ReadonlySet<number>;
  /** Reads the market account now and says whether its maker list is on; throws when it cannot be read. A test fake may omit it. */
  readMakersListed?: (marketId: number) => Promise<boolean>;
  /** When the rollup sign-in token this session reads with lapses; the session is rebuilt before then. */
  tokenExpiresAtMs: number;
  /** Saves this session's current order-key checkpoint, for the next session to restore from. See checkpointStore.ts. */
  saveKeyCheckpoint(): void;
  /** Brings the idle order keys in line with the keys the view holds, after another tab or device used one. A test fake may omit it. */
  resyncKeys?(view: View): void;
  /** Ends the client's background subscription and refreshes (0.5.0+); a no-op for a test fake that omits `close`. */
  close(): void;
}

export interface RollupSessionDeps {
  simUrl: string;
  overrides?: DeploymentOverrides;
  fetchFn?: typeof fetch;
  now?: () => number;
  /** Where the per-device order seed is kept; this browser's own store by default. */
  seeds?: DeviceSeeds;
  sleep?: (ms: number) => Promise<void>;
  /** Told how the order keys stand while the session is built (a new device waits before replacing them). */
  onOrderKeys?: (status: OrderKeyStatus) => void;
}

/**
 * The order book program this build signs for, fixed when it is built:
 * NEXT_PUBLIC_ORDERBOOK_PROGRAM_ID when set, the package's own program id
 * otherwise. `/v1/deployment` must report the same one; a service that
 * could name the program could point every address, and every transaction
 * the owner signs, at a program of its choosing.
 */
export function trustedProgramId(overrides: DeploymentOverrides = {}): PublicKey {
  const pinned = overrides.pins?.programId ?? overrides.programId;
  return pinned ? new PublicKey(pinned) : PACKAGE_PROGRAM_ID;
}

/**
 * The sign-in step of building a session failed. It happens before any
 * order exists, so building the session again is the one retry that can
 * never send anything twice.
 */
export class SessionAuthError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? redactToken(cause.message) : "Sign-in to the rollup failed");
    this.name = "SessionAuthError";
  }
}

const USER_REFUSAL = /reject|declin|denied|cancel|refus/i;

/**
 * Whether building the session again is worth doing automatically after a
 * failed sign-in. It is not when the owner refused the wallet prompt, the
 * network check refused to ask the wallet, or the wallet's account changed
 * under the request: repeating any of those would prompt the owner again, or
 * fail the same way, without anyone having asked. The next user action may try.
 */
export function retriesSignIn(cause: unknown): boolean {
  if (cause instanceof NetworkRefused || cause instanceof StaleSigner) return false;
  if (typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === 4001) {
    return false;
  }
  return !(cause instanceof Error && USER_REFUSAL.test(`${cause.name} ${cause.message}`));
}

interface ExchangeTokens {
  /** The token mint at each index. */
  mints: string[];
  /** The collateral token's mint and custody nonce, which name its custody authority and custody account. */
  collateral: CustodyToken;
  /** The gate that is the fee payer of an account opening. */
  gate: PublicKey;
}

/**
 * The Exchange account's registered tokens (public). Read at the program's
 * own Exchange address, not the one `/v1/deployment` names.
 */
async function readExchangeTokens(
  connection: Connection,
  exchangeAddress: PublicKey,
): Promise<ExchangeTokens> {
  const account = await connection.getAccountInfo(exchangeAddress);
  if (!account) throw new Error("the exchange account is not readable here");
  const exchange = decodeExchangeAccount(account.data);
  const collateral = exchange.tokens[exchange.collateralToken];
  if (!collateral) throw new Error("the exchange account names no collateral token");
  return {
    mints: exchange.tokens.map((token) => token.mint.toBase58()),
    collateral: { mint: collateral.mint, custodyNonce: collateral.custodyNonce },
    gate: exchange.gate,
  };
}

/**
 * Matches the Exchange account's mints against every market's own token
 * descriptions (which carry symbol + decimals but not the index
 * `Seat.spot[]` uses) to resolve symbol -> index. One read, not a scan of
 * every market account the way resolving numeric market ids used to
 * require before `/v1/deployment` existed.
 */
function tokenIndicesBySymbol(
  exchangeMints: readonly string[],
  deployment: PublicDeployment,
): Map<string, number> {
  const mintToSymbol = new Map<string, string>();
  for (const market of deployment.markets) {
    mintToSymbol.set(market.quoteToken.mint, market.quoteToken.symbol);
    if (market.baseToken) mintToSymbol.set(market.baseToken.mint, market.baseToken.symbol);
  }
  const bySymbol = new Map<string, number>();
  exchangeMints.forEach((mint, index) => {
    const symbol = mintToSymbol.get(mint);
    if (symbol) bySymbol.set(symbol, index);
  });
  return bySymbol;
}

interface MatchingMarkets {
  markets: PublicDeployment["markets"];
  maxPriceAgeSeconds: Map<number, number>;
  maintenanceMarginBps: Map<number, number>;
  makersListed: Set<number>;
}

/**
 * The deployment's markets whose entry says the same as the market account
 * the rollup holds at that market's address (see `marketMatchesChain`), with
 * each kept market's own price age limit as its account states it. A market
 * that does not match is left out, and so cannot be traded from here.
 */
async function marketsMatchingChain(
  connection: Connection,
  programId: PublicKey,
  deployment: PublicDeployment,
  exchangeMints: readonly string[],
): Promise<MatchingMarkets> {
  const matching: MatchingMarkets = {
    markets: [],
    maxPriceAgeSeconds: new Map(),
    maintenanceMarginBps: new Map(),
    makersListed: new Set(),
  };
  if (deployment.markets.length === 0) return matching;
  const addresses = programAddresses(programId);
  const accounts = await connection.getMultipleAccountsInfo(
    deployment.markets.map((market) => addresses.market(market.marketId)),
  );
  deployment.markets.forEach((market, index) => {
    const account = accounts[index];
    if (!account) return;
    let chain: ReturnType<typeof decodeMarketAccount>;
    try {
      chain = decodeMarketAccount(account.data);
    } catch {
      return;
    }
    if (!marketMatchesChain(market, chain, exchangeMints)) return;
    matching.markets.push(market);
    matching.maxPriceAgeSeconds.set(market.marketId, Number(chain.params.maxPriceAge));
    matching.maintenanceMarginBps.set(market.marketId, chain.params.mmBps);
    if (isMakersListed(chain.params.access)) matching.makersListed.add(market.marketId);
  });
  return matching;
}

const isErrorWithMessage = (error: unknown, message: string) =>
  error instanceof Error && error.message === message;

/**
 * How far the first, quick searches look. The full search (100,000 indices)
 * takes many seconds when the keys are not there, so it runs only once the
 * quick ones have ruled out the common cases: this seed's keys not far in,
 * or keys left from the earlier seed derivation.
 */
const QUICK_KEY_SEARCH = 1_024;

/**
 * The owner's view, or null while the account is not opened. A one-shot read,
 * thrown away right after: no benefit from a live result subscription here,
 * so it asks for none. Any other failure is thrown, never mistaken for a
 * missing account.
 */
async function readOwnerView(
  reader: Connection,
  owner: PublicKey,
  keys: OrderKeyManager,
  programId: PublicKey,
): Promise<View | null> {
  try {
    return await new TraderClient(reader, reader, owner, keys, programId, { push: false }).view();
  } catch (error) {
    if (isErrorWithMessage(error, VIEW_NOT_READABLE_MESSAGE)) return null;
    throw error;
  }
}

/**
 * The account's live order keys on a test build, whose seed comes from the
 * built-in wallet's secret. No view yet (account not opened): the fresh
 * keys, exactly what `open_trader` will be asked to install. A view whose
 * keys this seed never derived (installed under the earlier,
 * signature-based seed): the owner installs the fresh keys over them with
 * `set_order_keys`, the one way back to keys only this device can derive.
 */
async function derivedOrderKeys(
  reader: Connection,
  owner: OwnerSigner,
  seeds: DerivedOrderSeeds,
  programId: PublicKey,
  checkpoint: ReturnType<typeof loadCheckpoint>,
  install: (fresh: OrderKeyManager) => Promise<void>,
): Promise<OrderKeyManager> {
  const fresh = freshOrderKeys(seeds.seed);
  const notFromSeed = (error: unknown) => isErrorWithMessage(error, KEYS_NOT_FROM_SEED_MESSAGE);
  const existingView = await readOwnerView(reader, owner.publicKey, fresh, programId);
  if (!existingView) return fresh;
  try {
    return orderKeysFromCheckpoint(seeds.seed, existingView, checkpoint, QUICK_KEY_SEARCH);
  } catch (error) {
    if (!notFromSeed(error)) throw error;
  }
  if (!viewKeysDeriveFrom(seeds.legacySeed, existingView, QUICK_KEY_SEARCH)) {
    try {
      return orderKeysFromCheckpoint(seeds.seed, existingView, null);
    } catch (error) {
      if (!notFromSeed(error)) throw error;
    }
  }
  await install(fresh);
  return fresh;
}

/** A read the rollup refused for want of a valid token, as opposed to any other failure. */
const looksUnauthorized = (error: unknown) =>
  error instanceof Error &&
  /\b401\b|unauthori[sz]ed|missing token|invalid token|token (?:expired|invalid)/i.test(
    error.message,
  );

/**
 * Who signs for this session. A mainnet session takes only the signer made
 * by `mainnetOwnerSigner` (the Wallet Standard signer with the network
 * check in front of every signature) and no secret at all; a test build
 * takes a signer, or the built-in wallet's secret, which `secretOwner`
 * refuses on a mainnet build.
 */
function ownerAccessOf(
  wallet: WalletIdentity,
  mainnet: boolean,
): { signer: OwnerSigner; derivedSeeds?: DerivedOrderSeeds } {
  if (mainnet) {
    if (wallet.secretKeyHex !== undefined) {
      throw new Error("A mainnet session never takes a wallet secret.");
    }
    if (!wallet.signer || !isMainnetOwnerSigner(wallet.signer)) {
      throw new Error("A mainnet session signs only through the network-checked wallet signer.");
    }
    return { signer: wallet.signer };
  }
  if (wallet.signer) return { signer: wallet.signer };
  if (wallet.secretKeyHex) return secretOwner({ secretKeyHex: wallet.secretKeyHex });
  throw new Error("This trading client needs the wallet's signer (rollup mode signs through it)");
}

/**
 * Builds a real session, with every error's text scrubbed of the sign-in
 * token (see `buildSession`).
 */
export async function buildRealSession(
  wallet: WalletIdentity,
  deps: RollupSessionDeps,
): Promise<RollupSession> {
  try {
    return await buildSession(wallet, deps);
  } catch (error) {
    throw scrubError(error);
  }
}

/**
 * Fetches the deployment description (`/v1/deployment`), signs in to the
 * rollup (the hosted rollup needs a signed-in token before it will accept a
 * send, not only before a private read, so this happens before anything
 * else, not lazily on first trade: the owner's wallet is asked only when
 * this device holds no unexpired token for it) and recovers the live order
 * keys: on mainnet from this device's random seed, on a test build from the
 * seed the built-in wallet derives; from a saved checkpoint when one exists,
 * from the view's own key list otherwise, or a fresh set when there is no
 * view yet (the keys `open_trader` will be given). Only the markets whose
 * `/v1/deployment` entry matches the rollup's own market account are kept.
 * `refresh()` (in `RollupTradingClient`) calls this again to rebuild
 * `reader` and the client.
 */
async function buildSession(
  wallet: WalletIdentity,
  deps: RollupSessionDeps,
): Promise<RollupSession> {
  const mainnet = Boolean(deps.overrides?.pins) || isMainnetBuild();
  const { signer, derivedSeeds } = ownerAccessOf(wallet, mainnet);
  const ownerKey = signer.publicKey;
  const ownerAddress = ownerKey.toBase58();
  if (wallet.address !== ownerAddress) {
    throw new Error("The wallet's signer is not for the address this session was asked to trade.");
  }
  const now = deps.now ?? Date.now;
  const fetchFn = deps.fetchFn ?? fetch;
  const described = await fetchDeployment(deps.simUrl, deps.overrides, fetchFn);
  const programId = trustedProgramId(deps.overrides);
  if (described.programId !== programId.toBase58()) {
    throw new Error(
      `the service describes program ${described.programId}, but this build trades on ${programId.toBase58()}`,
    );
  }

  const pinnedValidator = deps.overrides?.pins?.validator;
  if (pinnedValidator) {
    await assertRollupIdentity(described.rollupRpcUrl, pinnedValidator, fetchFn);
  }

  // A plain, unsigned connection, for reads that are genuinely public
  // (DESIGN.md section 2: "everyone" - here, only the Exchange account).
  const anonymous = connectionTo(described.rollupRpcUrl, described.rollupWsUrl);
  const storage = browserLocalStorage();
  const checkpoint = loadCheckpoint(storage, ownerAddress);
  const report = deps.onOrderKeys ?? (() => {});
  const seeds = deps.seeds ?? { load: loadOrderSeed, create: createOrderSeed };
  const signIn = (fresh: boolean): Promise<SignedIn> =>
    signedInReader(
      {
        rollupRpcUrl: described.rollupRpcUrl,
        owner: signer,
        storage,
        now,
        signIn: signInWithExpiry,
        connect: connectWithToken,
      },
      { fresh },
    ).catch((error: unknown) => {
      throw new SessionAuthError(error);
    });
  const installOn = (reader: Connection, fresh: OrderKeyManager): Promise<void> =>
    usesOwnerMessages(described)
      ? installOrderKeysSigned(reader, signer, fresh, programId)
      : installOrderKeys(reader, signer, fresh, programId);
  const orderKeysOn = (reader: Connection): Promise<OrderKeyManager> =>
    derivedSeeds
      ? derivedOrderKeys(reader, signer, derivedSeeds, programId, checkpoint, (fresh) =>
          installOn(reader, fresh),
        )
      : deviceOrderKeys({
          ownerAddress,
          seeds,
          checkpoint,
          readView: (fresh) => readOwnerView(reader, ownerKey, fresh, programId),
          install: (fresh) => installOn(reader, fresh),
          report,
          now,
          sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
        });

  // The query filter (deployment.rollupRpcUrl) serves both the anonymous
  // read above and the signed-in connection below, at the same address:
  // sign-in is a token appended to it, not a separate endpoint. On this
  // stack SENDING a transaction needs that same signed-in token too, not
  // only reading privately - confirmed by hand (an unsigned send answers
  // 401 "Missing token query param") - so `reader` is used as both the
  // `TraderClient`'s sending connection and its private reader, never the
  // plain `anonymous` one. A cached token the rollup no longer accepts is
  // dropped and signed for once more.
  let signedIn = await signIn(false);
  let keys: OrderKeyManager;
  try {
    keys = await orderKeysOn(signedIn.reader);
  } catch (error) {
    if (!signedIn.cached || !looksUnauthorized(error)) throw error;
    clearSignInToken(storage, ownerAddress);
    signedIn = await signIn(true);
    keys = await orderKeysOn(signedIn.reader);
  }
  const reader = signedIn.reader;
  report({ stage: "ready" });
  const saveKeyCheckpoint = () => saveCheckpoint(storage, ownerAddress, checkpointOf(keys));
  // Saved now as well as after every confirmed call, so a checkpoint the
  // keys had moved beyond is replaced rather than searched past each time.
  saveKeyCheckpoint();

  const exchangeTokens = await readExchangeTokens(anonymous, programAddresses(programId).exchange);
  const pinnedMint = deps.overrides?.pins?.usdcMint;
  if (pinnedMint && exchangeTokens.collateral.mint.toBase58() !== pinnedMint) {
    throw new Error(
      `the exchange holds collateral in ${exchangeTokens.collateral.mint.toBase58()}, but this build trades only in ${pinnedMint}`,
    );
  }
  const exchangeMints = exchangeTokens.mints;
  const matching = await marketsMatchingChain(reader, programId, described, exchangeMints);
  const deployment: PublicDeployment = { ...described, markets: matching.markets };

  // `push` defaults to on; this is the client every order actually goes
  // through, so `ready()` is awaited once here, right after sign-in - the
  // subscription is already live by the time the trader places a first
  // order, rather than that order itself paying for warming it up.
  const client = new TraderClient(reader, reader, ownerKey, keys, programId);
  await client.ready();

  return {
    owner: signer,
    orderKeyPublicKeys: orderKeyPublicKeys(keys),
    client,
    deployment,
    reader,
    tokenIndexBySymbol: tokenIndicesBySymbol(exchangeMints, deployment),
    collateralToken: exchangeTokens.collateral,
    gate: exchangeTokens.gate,
    maxPriceAgeSeconds: matching.maxPriceAgeSeconds,
    maintenanceMarginBps: matching.maintenanceMarginBps,
    makersListed: matching.makersListed,
    readMakersListed: async (marketId) => {
      const account = await reader.getAccountInfo(programAddresses(programId).market(marketId));
      if (!account) throw new Error("the market account could not be read");
      return isMakersListed(decodeMarketAccount(account.data).params.access);
    },
    tokenExpiresAtMs: signedIn.expiresAtMs,
    saveKeyCheckpoint,
    resyncKeys: (view) => keys.resync(view),
    close: () => client.close(),
  };
}
