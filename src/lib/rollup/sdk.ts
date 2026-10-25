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
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  ACCESS_ERROR as SDK_ACCESS_ERROR,
  Addresses,
  Instructions,
  MARKET_KIND,
  OrderInvalid as SdkOrderInvalid,
  OrderKeyManager,
  ORDER_TYPE,
  OutcomeUnknown as SdkOutcomeUnknown,
  PROGRAM_ID,
  RESULT_STATUS,
  ROLE,
  SIDE,
  TraderClient as SdkTraderClient,
  TransactionFailed as SdkTransactionFailed,
  decodeExchange,
  decodeMarket,
  randomSecret,
  receipt as sdkReceipt,
  sendAndConfirm,
  signIn as sdkSignIn,
  websocketUrl,
  type CustodyToken,
  type OrderKeyCheckpoint,
  type OrderResult,
  type Placed,
  type Settled,
  type SignMessage,
  type Timing,
  type View,
} from "@noirwire/orderbook";

export type {
  CustodyToken,
  View,
  OrderResult,
  Placed,
  Settled,
  SignMessage,
  Timing,
  OrderKeyCheckpoint,
  OrderKeyManager,
};
export { randomSecret };
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
 * Replaces the four order keys a view holds, signed by the owner key: the
 * one way back for an account whose keys this device cannot derive.
 */
export async function installOrderKeys(
  connection: Connection,
  owner: Keypair,
  keys: OrderKeyManager,
  programId: PublicKey,
): Promise<void> {
  const instruction = new Instructions(programId).setOrderKeys(owner.publicKey, keys.publicKeys);
  await sendAndConfirm(connection, [instruction], owner);
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
  if (plainTextBodiesAccepted) {
    const response = await fetch(input, { ...init, headers: { "content-type": "text/plain" } });
    if (response.status !== UNSUPPORTED_MEDIA_TYPE) return response;
    plainTextBodiesAccepted = false;
  }
  return fetch(input, init);
};

export function connectionTo(rpcUrl: string, wsUrl: string): Connection {
  return new Connection(rpcUrl, {
    commitment: "confirmed",
    wsEndpoint: wsUrl,
    fetch: preflightFreeFetch,
  });
}

export async function signInAndConnect(
  privateUrl: string,
  reader: PublicKey,
  signMessage: SignMessage,
): Promise<Connection> {
  const token = await sdkSignIn(privateUrl, reader, signMessage);
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
}

/** The program's numeric codes this module's callers need, named for what they mean here. */
export const SIDE_CODE = { buy: SIDE.bid, sell: SIDE.ask } as const;
export const ORDER_TYPE_CODE = { market: ORDER_TYPE.market, limit: ORDER_TYPE.limit } as const;
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
