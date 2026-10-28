/**
 * The ONLY module that imports `@noirwire/orderbook`. Everything else in
 * `src/lib/rollup` and `src/lib/trading` sees the plain types re-exported or
 * defined here, so a client package upgrade is an edit to this one file.
 * Mirrors the same discipline sim-noirwire's own `src/rollup/program.ts`
 * follows for the same package (see that repo's docs/DESIGN.md, "The rollup
 * venue"). Currently on 0.6.0, which names every perp market in each
 * order-key call itself, read from the Exchange account, so no caller passes
 * a risk market list any more.
 */
import "../bufferBigInt";
import { Connection, PublicKey, type Keypair } from "@solana/web3.js";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import type { OwnerSigner } from "../wallet/ownerSigner";
import { sendOwnerSigned } from "./ownerSend";
import { scrubError } from "./redact";
import {
  ACCESS_ERROR as SDK_ACCESS_ERROR,
  Addresses,
  Instructions,
  MARKET_ACCESS,
  MARKET_KIND,
  OrderInvalid as SdkOrderInvalid,
  OrderKeyManager,
  ORDER_TYPE,
  OutcomeUnknown as SdkOutcomeUnknown,
  OWNER_TRANSACTION_ERROR,
  PROGRAM_ID,
  RESULT_STATUS,
  ROLE,
  SIDE,
  TraderClient as SdkTraderClient,
  TransactionFailed as SdkTransactionFailed,
  WithdrawalUnknown as SdkWithdrawalUnknown,
  clockOf as sdkClockOf,
  decodeExchange,
  decodeMarket,
  ownerActionMessage as sdkOwnerActionMessage,
  ownerExpiry as sdkOwnerExpiry,
  randomSecret,
  receipt as sdkReceipt,
  replaceKeysSignedTransaction,
  verifyOwnerSignature as sdkVerifyOwnerSignature,
  websocketUrl,
  type CustodyToken,
  type OrderKeyCheckpoint,
  type OrderResult,
  type OwnerMessageForm,
  type Placed,
  type Settled,
  type SignMessage,
  type Timing,
  type View,
  type WithdrawalUndetermined,
  type Withdrawn,
} from "@noirwire/orderbook";

export type {
  CustodyToken,
  View,
  OrderResult,
  OwnerMessageForm,
  Placed,
  Settled,
  SignMessage,
  Timing,
  OrderKeyCheckpoint,
  OrderKeyManager,
  WithdrawalUndetermined,
  Withdrawn,
};
export { randomSecret };
/** The program's owner-action errors as a failed transaction reports them (6151 to 6154). */
export const OWNER_ERROR_CODE = OWNER_TRANSACTION_ERROR;
export const WithdrawalUnknown = SdkWithdrawalUnknown;
export const ACCESS_ERROR = SDK_ACCESS_ERROR;
export const OrderInvalid = SdkOrderInvalid;
export const TransactionFailed = SdkTransactionFailed;
export const OutcomeUnknown = SdkOutcomeUnknown;
/** `keys.take()`'s own message when every one of the four order-key slots is already lent out. Not a typed error in the package; matched on its exact text. */
export const ALL_KEYS_BUSY_MESSAGE = "every order key is in use";
/** `TraderClient.view()`'s own message (0.6.0) when the view account does not exist (the account is not opened yet). Matched on its exact text. */
export const VIEW_NOT_READABLE_MESSAGE =
  "the view is not readable by this connection: read through a private connection signed in as the owner";
/** `OrderKeyManager.fromView`'s own message when the view holds keys this seed never derived. Matched on its exact text. */
export const KEYS_NOT_FROM_SEED_MESSAGE = "the view's order keys do not all derive from this seed";
/** The program id this package release was built for. */
export const PACKAGE_PROGRAM_ID = PROGRAM_ID;
export const MARKET_KIND_CODE = MARKET_KIND;

export function programAddresses(programId: PublicKey): Addresses {
  return new Addresses(programId);
}

export function programInstructions(programId: PublicKey): Instructions {
  return new Instructions(programId);
}

export function decodeMarketAccount(data: Uint8Array) {
  return decodeMarket(data);
}

/**
 * Replaces the four order keys a view holds, signed by the owner through the
 * signer port and sent only when the signed transaction is the one built
 * here: the one way back for an account whose keys this device cannot use.
 */
export async function installOrderKeys(
  connection: Connection,
  owner: OwnerSigner,
  keys: OrderKeyManager,
  programId: PublicKey,
): Promise<void> {
  const instruction = new Instructions(programId).setOrderKeys(owner.publicKey, keys.publicKeys);
  await sendOwnerSigned(connection, [instruction], owner);
}

/** The text an owner action asks the wallet to sign (open or replace), exactly as the program rebuilds it. */
export function ownerActionText(
  action: "open" | "replace",
  programId: PublicKey,
  owner: PublicKey,
  keys: PublicKey[],
  expiresAt: bigint,
  nonce?: number,
): Uint8Array {
  return sdkOwnerActionMessage(action, programId, owner, keys, expiresAt, nonce);
}

/** The expiry for an owner action signed now: 100 seconds past the rollup's clock reading, never past the program's limit. */
export function ownerActionExpiry(rollupClockSeconds: number): bigint {
  return sdkOwnerExpiry(rollupClockSeconds);
}

/** Which form of `message` the owner signed (raw, off-chain envelope or the specification's header naming `programId`), or null when `signature` is none of them. */
export function ownerSignatureForm(
  message: Uint8Array,
  signature: Uint8Array,
  owner: PublicKey,
  programId: PublicKey,
): OwnerMessageForm | null {
  return sdkVerifyOwnerSignature(message, signature, owner, programId);
}

/** The rollup's clock in unix seconds, as `connection` serves it. */
export function rollupClockSeconds(connection: Connection): Promise<number> {
  return sdkClockOf(connection);
}

/**
 * The whole `set_order_keys_signed` transaction for an owner's signature over
 * the replace message: the proof first, then the replacement. The owner does
 * not sign it, so `feePayer` alone pays and signs.
 */
export function signedKeyReplacement(
  connection: Connection,
  programId: PublicKey,
  feePayer: Keypair,
  replacement: {
    owner: PublicKey;
    orderKeys: PublicKey[];
    nonce: number;
    expiresAt: bigint;
    signature: Uint8Array;
    form: OwnerMessageForm;
  },
): Promise<{ raw: Uint8Array; signature: string }> {
  return replaceKeysSignedTransaction(
    connection,
    new Instructions(programId),
    feePayer,
    replacement,
  );
}

const UNSUPPORTED_MEDIA_TYPE = 415;
let plainTextBodiesAccepted = true;

/**
 * The hosted rollup endpoint answers a CORS preflight without
 * `Access-Control-Max-Age`, so a browser repeats the preflight for any JSON
 * request made more than five seconds after the last one: a second round
 * trip in front of nearly every order. A `text/plain` body with no custom
 * header needs no preflight, and the endpoint parses it as JSON all the
 * same. An endpoint that insists on `application/json` answers 415 once and
 * gets the original headers from then on.
 */
const preflightFreeFetch: typeof fetch = async (input, init) => {
  try {
    if (plainTextBodiesAccepted) {
      const response = await fetch(input, { ...init, headers: { "content-type": "text/plain" } });
      if (response.status !== UNSUPPORTED_MEDIA_TYPE) return response;
      plainTextBodiesAccepted = false;
    }
    return await fetch(input, init);
  } catch (error) {
    // The connection's URL carries the sign-in token; a failed request must not repeat it.
    throw scrubError(error);
  }
};

export function connectionTo(rpcUrl: string, wsUrl: string): Connection {
  return new Connection(rpcUrl, {
    commitment: "confirmed",
    wsEndpoint: wsUrl,
    fetch: preflightFreeFetch,
  });
}

const MILLISECOND_EPOCH = 1e12;

/**
 * Signs in to the private endpoint: `signMessage` signs the endpoint's
 * challenge, and the token comes back with the time it lapses (the endpoint's
 * own `expiresAt`, in milliseconds, or seconds from an endpoint that sends
 * those).
 */
export async function signInWithExpiry(
  privateUrl: string,
  reader: PublicKey,
  signMessage: SignMessage,
): Promise<{ token: string; expiresAtMs: number }> {
  const { token, expiresAt } = await getAuthToken(privateUrl, reader, signMessage);
  return { token, expiresAtMs: expiresAt < MILLISECOND_EPOCH ? expiresAt * 1000 : expiresAt };
}

/** A connection to the private endpoint that reads as the owner `token` was signed for. */
export function connectWithToken(privateUrl: string, token: string): Connection {
  return connectionTo(`${privateUrl}?token=${token}`, `${websocketUrl(privateUrl)}?token=${token}`);
}

export function freshOrderKeys(seed: Uint8Array): OrderKeyManager {
  return OrderKeyManager.fresh(seed);
}

/**
 * Picks up from a saved checkpoint (a handful of keys derived, rather than
 * searching the whole space from index 0) when one exists; falls back to
 * the slower `fromView` search otherwise: first visit on this device, a
 * checkpoint that did not survive, or one `restore` cannot use (further
 * behind than its window, after trading from another device, or holding
 * indices that are not indices). Throws only when the view's keys do not
 * derive from `seed` within `searchLimit` indices (the package's own
 * default, 100,000, when omitted).
 */
export function orderKeysFromCheckpoint(
  seed: Uint8Array,
  view: Pick<View, "orderKeys">,
  checkpoint: OrderKeyCheckpoint | null,
  searchLimit?: number,
): OrderKeyManager {
  if (checkpoint) {
    try {
      return OrderKeyManager.restore(seed, view, checkpoint);
    } catch {
      // Out of the checkpoint's reach: the full search below finds them.
    }
  }
  return OrderKeyManager.fromView(seed, view, searchLimit);
}

/** Whether every key `view` holds derives from `seed` within `searchLimit` indices. */
export function viewKeysDeriveFrom(
  seed: Uint8Array,
  view: Pick<View, "orderKeys">,
  searchLimit: number,
): boolean {
  try {
    OrderKeyManager.fromView(seed, view, searchLimit);
    return true;
  } catch {
    return false;
  }
}

export function checkpointOf(keys: OrderKeyManager): OrderKeyCheckpoint {
  return keys.checkpoint;
}

export function orderKeyPublicKeys(keys: OrderKeyManager): string[] {
  return keys.publicKeys.map((key) => key.toBase58());
}

export class TraderClient {
  private readonly inner: SdkTraderClient;

  constructor(
    connection: Connection,
    reader: Connection,
    owner: PublicKey,
    keys: OrderKeyManager,
    programId: PublicKey,
    options?: { push?: boolean },
  ) {
    this.inner = new SdkTraderClient(connection, reader, owner, keys, programId, options);
  }

  /**
   * Resolves once the client needs nothing but a send for its next call: a
   * blockhash, the rollup's clock, and (when `push` is on, the default) a
   * live result subscription are all in hand. Call once after sign-in, not
   * per order - a call already warm costs the order itself one request.
   */
  ready(): Promise<void> {
    return this.inner.ready();
  }

  /** Ends the background subscription and refreshes. A later call starts them again. */
  close(): void {
    this.inner.close();
  }

  view(): Promise<View> {
    return this.inner.view();
  }

  subscribeView(onChange: (view: View) => void): () => Promise<void> {
    return this.inner.subscribeView(onChange);
  }

  /** May throw `OrderInvalid` (refused before signing) or `TransactionFailed` (landed and failed). */
  async placeOrder(
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
    options: { expirySeconds?: number; pushWaitMs?: number } = {},
  ): Promise<Placed> {
    return this.inner.placeOrder(marketId, order, options);
  }

  /** May throw `OutcomeUnknown` (carries `settled`) instead of returning, once the device gives up waiting before the outcome is certain. */
  cancelOrder(
    marketId: number,
    orderSeq: bigint,
    expirySeconds?: number,
  ): Promise<OrderResult & Timing> {
    return this.inner.cancelOrder(marketId, orderSeq, expirySeconds);
  }

  /** May throw `OutcomeUnknown`; see `cancelOrder`. */
  cancelAll(marketId: number, expirySeconds?: number): Promise<OrderResult & Timing> {
    return this.inner.cancelAll(marketId, undefined, expirySeconds);
  }

  /** May throw `OutcomeUnknown`; see `cancelOrder`. */
  syncView(marketId: number, expirySeconds?: number): Promise<OrderResult & Timing> {
    return this.inner.syncView(marketId, expirySeconds);
  }

  /** May throw `OutcomeUnknown`; see `cancelOrder`. */
  transferBetweenBalances(
    toCollateral: boolean,
    spotToken: number,
    amount: bigint,
    expirySeconds?: number,
  ): Promise<OrderResult & Timing> {
    return this.inner.transferBetweenBalances(toCollateral, spotToken, amount, expirySeconds);
  }

  /**
   * Withdraws collateral to the owner's own token account, signed by a live
   * order key. May throw `TransactionFailed` (refused, key still live) or
   * `WithdrawalUnknown` (sent, not seen; its `settled` says what became of it).
   */
  withdrawByKey(token: CustodyToken, amount: bigint, expirySeconds?: number): Promise<Withdrawn> {
    return this.inner.withdrawByKey(token, { collateral: true }, amount, expirySeconds);
  }
}

/** The program's numeric codes this module's callers need, named for what they mean here. */
export const SIDE_CODE = { buy: SIDE.bid, sell: SIDE.ask } as const;
export const ORDER_TYPE_CODE = {
  market: ORDER_TYPE.market,
  limit: ORDER_TYPE.limit,
  immediateOrCancel: ORDER_TYPE.immediateOrCancel,
} as const;

/** Whether a market's `params.access` has the maker list switched on: only listed seats may rest orders. */
export const isMakersListed = (access: number): boolean =>
  (access & MARKET_ACCESS.makersListed) !== 0;
export const RESULT_STATUS_CODE = RESULT_STATUS;

export function decodeExchangeAccount(data: Uint8Array) {
  return decodeExchange(data);
}

/** The maker/taker receipt for one of this browser's own order secrets at a given fill. */
export function fillReceipt(
  secret: Uint8Array,
  fillSeq: bigint,
  role: "maker" | "taker",
): Uint8Array {
  return sdkReceipt(secret, fillSeq, role === "maker" ? ROLE.maker : ROLE.taker);
}
