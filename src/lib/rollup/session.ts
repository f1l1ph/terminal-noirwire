import type { Keypair } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { browserLocalStorage, type WalletAccount } from "../wallet/index";
import { loadCheckpoint, saveCheckpoint } from "./checkpointStore";
import { deriveOrderSeed, ownerKeypairFrom } from "./keys";
import { MintDecimalsCache } from "./mintDecimals";
import { resolveDeployment, type ResolvedDeployment } from "./marketIds";
import {
  checkpointOf,
  connectionTo,
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
    options?: { expirySeconds?: number; riskMarkets?: number[] },
  ): Promise<Placed>;
  cancelOrder(marketId: number, orderSeq: bigint): Promise<(OrderResult & Timing) | null>;
  cancelAll(marketId: number): Promise<(OrderResult & Timing) | null>;
  syncView(marketId: number): Promise<(OrderResult & Timing) | null>;
  transferBetweenBalances(
    toCollateral: boolean,
    spotToken: number,
    amount: bigint,
    riskMarkets: number[],
  ): Promise<(OrderResult & Timing) | null>;
}

export interface RollupSession {
  owner: Keypair;
  orderKeyPublicKeys: string[];
  client: TraderClientLike;
  mintDecimals: { decimalsOf(tokenIndex: number): Promise<number> };
  deployment(): Promise<ResolvedDeployment>;
  createdAtMs: number;
  /** Saves this session's current order-key checkpoint, for the next session to restore from. See checkpointStore.ts. */
  saveKeyCheckpoint(): void;
}

export interface RollupSessionDeps {
  rollupRpcUrl: string;
  rollupWsUrl: string;
  rollupPrivateUrl: string;
  programId: PublicKey;
  now?: () => number;
}

/**
 * Builds a real session: derives the owner key and the order-key seed from
 * the browser wallet (keys.ts), signs in to the rollup's private endpoint
 * right away (DESIGN.md section 4; the hosted rollup needs a signed-in
 * token before it will accept a send, not only before a private read, so
 * this happens before anything else, not lazily on first trade) and
 * recovers the live order keys: from a saved checkpoint when one exists
 * (a handful of derivations), from the view's own key list otherwise (a
 * full search), or starts a fresh set when there is no view yet (the keys
 * `open_trader` will be given). `refresh()` (in `RollupTradingClient`)
 * calls this again to rebuild `reader` and the client.
 */
export async function buildRealSession(
  wallet: WalletAccount,
  deps: RollupSessionDeps,
): Promise<RollupSession> {
  const owner = ownerKeypairFrom(wallet);
  const seed = deriveOrderSeed(owner);
  const connection = connectionTo(deps.rollupRpcUrl, deps.rollupWsUrl);
  const signMessage = async (message: Uint8Array) => nacl.sign.detached(message, owner.secretKey);
  const reader = await signInAndConnect(deps.rollupPrivateUrl, owner.publicKey, signMessage);

  const storage = browserLocalStorage();
  const checkpoint = loadCheckpoint(storage, owner.publicKey.toBase58());

  let keys: OrderKeyManager = freshOrderKeys(seed);
  try {
    const existingView = await new TraderClient(
      connection,
      reader,
      owner.publicKey,
      keys,
      deps.programId,
    ).view();
    keys = orderKeysFromCheckpoint(seed, existingView, checkpoint);
  } catch {
    // No view yet (account not opened): the fresh keys are exactly what
    // `open_trader` will be asked to install.
  }

  const client = new TraderClient(connection, reader, owner.publicKey, keys, deps.programId);
  const mintDecimals = new MintDecimalsCache(connection, deps.programId);
  let deploymentPromise: Promise<ResolvedDeployment> | null = null;

  return {
    owner,
    orderKeyPublicKeys: orderKeyPublicKeys(keys),
    client,
    mintDecimals,
    deployment: () => {
      if (!deploymentPromise) deploymentPromise = resolveDeployment(connection, deps.programId);
      return deploymentPromise;
    },
    createdAtMs: (deps.now ?? Date.now)(),
    saveKeyCheckpoint: () =>
      saveCheckpoint(storage, owner.publicKey.toBase58(), checkpointOf(keys)),
  };
}
