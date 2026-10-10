import type { Keypair } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { browserLocalStorage, type WalletAccount } from "../wallet/index";
import { loadCheckpoint, saveCheckpoint } from "./checkpointStore";
import { fetchDeployment, type DeploymentOverrides, type PublicDeployment } from "./deployment";
import { deriveOrderSeed, ownerKeypairFrom } from "./keys";
import {
  checkpointOf,
  connectionTo,
  decodeExchangeAccount,
  freshOrderKeys,
  orderKeyPublicKeys,
  orderKeysFromCheckpoint,
  signInAndConnect,
  TraderClient,
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
    options?: { expirySeconds?: number; riskMarkets?: number[]; pushWaitMs?: number },
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
    riskMarkets: number[],
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
 * Reads the Exchange account (public, its address is `deployment.exchange`)
 * for the token mint at each index, then matches those mints against every
 * market's own token descriptions (which carry symbol + decimals but not
 * the index `Seat.spot[]` uses) to resolve symbol -> index. One read, not a
 * scan of every market account the way resolving numeric market ids used
 * to require before `/v1/deployment` existed.
 */
async function resolveTokenIndices(
  connection: ReturnType<typeof connectionTo>,
  deployment: PublicDeployment,
): Promise<Map<string, number>> {
  const account = await connection.getAccountInfo(new PublicKey(deployment.exchange));
  if (!account) throw new Error("the exchange account is not readable here");
  const exchange = decodeExchangeAccount(account.data);
  const mintToSymbol = new Map<string, string>();
  for (const market of deployment.markets) {
    mintToSymbol.set(market.quoteToken.mint, market.quoteToken.symbol);
    if (market.baseToken) mintToSymbol.set(market.baseToken.mint, market.baseToken.symbol);
  }
  const bySymbol = new Map<string, number>();
  exchange.tokens.forEach((token, index) => {
    const symbol = mintToSymbol.get(token.mint.toBase58());
    if (symbol) bySymbol.set(symbol, index);
  });
  return bySymbol;
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
 * is no view yet (the keys `open_trader` will be given). `refresh()` (in
 * `RollupTradingClient`) calls this again to rebuild `reader` and the
 * client.
 */
export async function buildRealSession(
  wallet: WalletAccount,
  deps: RollupSessionDeps,
): Promise<RollupSession> {
  const fetchFn = deps.fetchFn ?? fetch;
  const deployment = await fetchDeployment(deps.simUrl, deps.overrides, fetchFn);
  const programId = new PublicKey(deployment.programId);

  const owner = ownerKeypairFrom(wallet);
  const seed = deriveOrderSeed(owner);
  // A plain, unsigned connection, for reads that are genuinely public
  // (DESIGN.md section 2: "everyone" - here, only the Exchange account).
  const anonymous = connectionTo(deployment.rollupRpcUrl, deployment.rollupWsUrl);
  const signMessage = async (message: Uint8Array) => nacl.sign.detached(message, owner.secretKey);
  // The query filter (deployment.rollupRpcUrl) serves both the anonymous
  // read above and the signed-in connection below, at the same address:
  // sign-in is a token appended to it, not a separate endpoint. On this
  // stack SENDING a transaction needs that same signed-in token too, not
  // only reading privately - confirmed by hand (an unsigned send answers
  // 401 "Missing token query param") - so `reader` is used as both the
  // `TraderClient`'s sending connection and its private reader, never the
  // plain `anonymous` one.
  const reader = await signInAndConnect(deployment.rollupRpcUrl, owner.publicKey, signMessage);

  const storage = browserLocalStorage();
  const checkpoint = loadCheckpoint(storage, owner.publicKey.toBase58());

  let keys: OrderKeyManager = freshOrderKeys(seed);
  try {
    // A one-shot read, thrown away right after: no benefit from a live
    // result subscription here, so it asks for none.
    const existingView = await new TraderClient(reader, reader, owner.publicKey, keys, programId, {
      push: false,
    }).view();
    keys = orderKeysFromCheckpoint(seed, existingView, checkpoint);
  } catch {
    // No view yet (account not opened): the fresh keys are exactly what
    // `open_trader` will be asked to install.
  }

  // `push` defaults to on; this is the client every order actually goes
  // through, so `ready()` is awaited once here, right after sign-in - the
  // subscription is already live by the time the trader places a first
  // order, rather than that order itself paying for warming it up.
  const client = new TraderClient(reader, reader, owner.publicKey, keys, programId);
  await client.ready();
  const tokenIndexBySymbol = await resolveTokenIndices(anonymous, deployment);

  return {
    owner,
    orderKeyPublicKeys: orderKeyPublicKeys(keys),
    client,
    deployment,
    tokenIndexBySymbol,
    createdAtMs: (deps.now ?? Date.now)(),
    saveKeyCheckpoint: () =>
      saveCheckpoint(storage, owner.publicKey.toBase58(), checkpointOf(keys)),
    close: () => client.close(),
  };
}
