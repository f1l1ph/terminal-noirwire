import type { Connection, Keypair } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { browserLocalStorage, type WalletAccount } from "../wallet/index";
import { loadCheckpoint, saveCheckpoint } from "./checkpointStore";
import { fetchDeployment, type DeploymentOverrides, type PublicDeployment } from "./deployment";
import { deriveLegacyOrderSeed, deriveOrderSeed, ownerKeypairFrom, signInSigner } from "./keys";
import { marketMatchesChain } from "./markets";
import {
  checkpointOf,
  connectionTo,
  decodeExchangeAccount,
  decodeMarketAccount,
  freshOrderKeys,
  installOrderKeys,
  KEYS_NOT_FROM_SEED_MESSAGE,
  orderKeyPublicKeys,
  orderKeysFromCheckpoint,
  PACKAGE_PROGRAM_ID,
  programAddresses,
  signInAndConnect,
  TraderClient,
  VIEW_NOT_READABLE_MESSAGE,
  viewKeysDeriveFrom,
  type CustodyToken,
  type OrderKeyManager,
  type OrderResult,
  type Placed,
  type Timing,
  type View,
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
  transferBetweenBalances(
    toCollateral: boolean,
    spotToken: number,
    amount: bigint,
    expirySeconds?: number,
  ): Promise<OrderResult & Timing>;
}

export interface RollupSession {
  owner: Keypair;
  orderKeyPublicKeys: string[];
  client: TraderClientLike;
  deployment: PublicDeployment;
  /** Token symbol -> its index in `Seat.spot[]`, resolved once from the Exchange account (not a market-by-market scan). */
  tokenIndexBySymbol: Map<string, number>;
  /** The Exchange's collateral token, read from the Exchange account: every funding deposit must name exactly its custody. */
  collateralToken: CustodyToken;
  /** Market id -> the oldest mark, in seconds, its account accepts an order against (`maxPriceAge`). A test fake may omit it. */
  maxPriceAgeSeconds?: ReadonlyMap<number, number>;
  createdAtMs: number;
  /** Saves this session's current order-key checkpoint, for the next session to restore from. See checkpointStore.ts. */
  saveKeyCheckpoint(): void;
  /** Ends the client's background subscription and refreshes (0.5.0+); a no-op for a test fake that omits `close`. */
  close(): void;
}

export interface RollupSessionDeps {
  simUrl: string;
  overrides?: DeploymentOverrides;
  fetchFn?: typeof fetch;
  now?: () => number;
}

/**
 * The order book program this build signs for, fixed when it is built:
 * NEXT_PUBLIC_ORDERBOOK_PROGRAM_ID when set, the package's own program id
 * otherwise. `/v1/deployment` must report the same one; a service that
 * could name the program could point every address, and every transaction
 * the owner signs, at a program of its choosing.
 */
export function trustedProgramId(overrides: DeploymentOverrides = {}): PublicKey {
  return overrides.programId ? new PublicKey(overrides.programId) : PACKAGE_PROGRAM_ID;
}

/**
 * The sign-in step of building a session failed. It happens before any
 * order exists, so building the session again is the one retry that can
 * never send anything twice.
 */
export class SessionAuthError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : "Sign-in to the rollup failed");
    this.name = "SessionAuthError";
  }
}

interface ExchangeTokens {
  /** The token mint at each index. */
  mints: string[];
  /** The collateral token's mint and custody nonce, which name its custody authority and custody account. */
  collateral: CustodyToken;
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
  const matching: MatchingMarkets = { markets: [], maxPriceAgeSeconds: new Map() };
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
 * The account's live order keys. No view yet (account not opened): the
 * fresh keys, exactly what `open_trader` will be asked to install. A view
 * whose keys this seed never derived (installed under the earlier,
 * signature-based seed): the owner installs the fresh keys over them with
 * `set_order_keys`, the one way back to keys only this device can derive.
 * Any other failure is thrown, never mistaken for a missing account.
 */
async function liveOrderKeys(
  reader: Connection,
  owner: Keypair,
  seed: Uint8Array,
  programId: PublicKey,
  checkpoint: ReturnType<typeof loadCheckpoint>,
): Promise<OrderKeyManager> {
  const fresh = freshOrderKeys(seed);
  const notFromSeed = (error: unknown) => isErrorWithMessage(error, KEYS_NOT_FROM_SEED_MESSAGE);
  let existingView: View;
  try {
    // A one-shot read, thrown away right after: no benefit from a live
    // result subscription here, so it asks for none.
    existingView = await new TraderClient(reader, reader, owner.publicKey, fresh, programId, {
      push: false,
    }).view();
  } catch (error) {
    if (isErrorWithMessage(error, VIEW_NOT_READABLE_MESSAGE)) return fresh;
    throw error;
  }
  try {
    return orderKeysFromCheckpoint(seed, existingView, checkpoint, QUICK_KEY_SEARCH);
  } catch (error) {
    if (!notFromSeed(error)) throw error;
  }
  if (!viewKeysDeriveFrom(deriveLegacyOrderSeed(owner), existingView, QUICK_KEY_SEARCH)) {
    try {
      return orderKeysFromCheckpoint(seed, existingView, null);
    } catch (error) {
      if (!notFromSeed(error)) throw error;
    }
  }
  await installOrderKeys(reader, owner, fresh, programId);
  return fresh;
}

/**
 * Builds a real session: fetches the deployment description (`/v1/deployment`),
 * derives the owner key and the order-key seed from the browser wallet
 * (keys.ts), signs in to the rollup right away (DESIGN.md section 4; the
 * hosted rollup needs a signed-in token before it will accept a send, not
 * only before a private read, so this happens before anything else, not
 * lazily on first trade) and recovers the live order keys: from a saved
 * checkpoint when one exists (a handful of derivations), from the view's
 * own key list otherwise (a full search), or starts a fresh set when there
 * is no view yet (the keys `open_trader` will be given). Only the markets
 * whose `/v1/deployment` entry matches the rollup's own market account are
 * kept. `refresh()` (in `RollupTradingClient`) calls this again to rebuild
 * `reader` and the client.
 */
export async function buildRealSession(
  wallet: WalletAccount,
  deps: RollupSessionDeps,
): Promise<RollupSession> {
  const fetchFn = deps.fetchFn ?? fetch;
  const described = await fetchDeployment(deps.simUrl, deps.overrides, fetchFn);
  const programId = trustedProgramId(deps.overrides);
  if (described.programId !== programId.toBase58()) {
    throw new Error(
      `the service describes program ${described.programId}, but this build trades on ${programId.toBase58()}`,
    );
  }

  const owner = ownerKeypairFrom(wallet);
  const seed = deriveOrderSeed(owner);
  // A plain, unsigned connection, for reads that are genuinely public
  // (DESIGN.md section 2: "everyone" - here, only the Exchange account).
  const anonymous = connectionTo(described.rollupRpcUrl, described.rollupWsUrl);
  // The query filter (deployment.rollupRpcUrl) serves both the anonymous
  // read above and the signed-in connection below, at the same address:
  // sign-in is a token appended to it, not a separate endpoint. On this
  // stack SENDING a transaction needs that same signed-in token too, not
  // only reading privately - confirmed by hand (an unsigned send answers
  // 401 "Missing token query param") - so `reader` is used as both the
  // `TraderClient`'s sending connection and its private reader, never the
  // plain `anonymous` one.
  const reader = await signInAndConnect(
    described.rollupRpcUrl,
    owner.publicKey,
    signInSigner(owner),
  ).catch((error: unknown) => {
    throw new SessionAuthError(error);
  });

  const storage = browserLocalStorage();
  const ownerAddress = owner.publicKey.toBase58();
  const keys = await liveOrderKeys(
    reader,
    owner,
    seed,
    programId,
    loadCheckpoint(storage, ownerAddress),
  );
  const saveKeyCheckpoint = () => saveCheckpoint(storage, ownerAddress, checkpointOf(keys));
  // Saved now as well as after every confirmed call, so a checkpoint the
  // keys had moved beyond is replaced rather than searched past each time.
  saveKeyCheckpoint();

  const exchangeTokens = await readExchangeTokens(anonymous, programAddresses(programId).exchange);
  const exchangeMints = exchangeTokens.mints;
  const matching = await marketsMatchingChain(reader, programId, described, exchangeMints);
  const deployment: PublicDeployment = { ...described, markets: matching.markets };

  // `push` defaults to on; this is the client every order actually goes
  // through, so `ready()` is awaited once here, right after sign-in - the
  // subscription is already live by the time the trader places a first
  // order, rather than that order itself paying for warming it up.
  const client = new TraderClient(reader, reader, owner.publicKey, keys, programId);
  await client.ready();

  return {
    owner,
    orderKeyPublicKeys: orderKeyPublicKeys(keys),
    client,
    deployment,
    tokenIndexBySymbol: tokenIndicesBySymbol(exchangeMints, deployment),
    collateralToken: exchangeTokens.collateral,
    maxPriceAgeSeconds: matching.maxPriceAgeSeconds,
    createdAtMs: (deps.now ?? Date.now)(),
    saveKeyCheckpoint,
    close: () => client.close(),
  };
}
