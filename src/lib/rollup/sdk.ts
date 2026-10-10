/**
 * The ONLY module that imports `@noirwire/orderbook`. Everything else in
 * `src/lib/rollup` and `src/lib/trading` sees the plain types re-exported or
 * defined here, so a client package upgrade is an edit to this one file.
 * Mirrors the same discipline sim-noirwire's own `src/rollup/program.ts`
 * follows for the same package (see that repo's docs/DESIGN.md, "The rollup
 * venue"). Currently on 0.5.0.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  Addresses,
  OrderInvalid as SdkOrderInvalid,
  OrderKeyManager,
  ORDER_TYPE,
  OutcomeUnknown as SdkOutcomeUnknown,
  RESULT_STATUS,
  ROLE,
  SIDE,
  TraderClient as SdkTraderClient,
  TransactionFailed as SdkTransactionFailed,
  decodeExchange,
  randomSecret,
  receipt as sdkReceipt,
  signIn as sdkSignIn,
  websocketUrl,
  type OrderKeyCheckpoint,
  type OrderResult,
  type Placed,
  type Settled,
  type SignMessage,
  type Timing,
  type View,
} from "@noirwire/orderbook";

export type {
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
export const OrderInvalid = SdkOrderInvalid;
export const TransactionFailed = SdkTransactionFailed;
export const OutcomeUnknown = SdkOutcomeUnknown;
/** `keys.take()`'s own message when every one of the four order-key slots is already lent out. Not a typed error in the package; matched on its exact text. */
export const ALL_KEYS_BUSY_MESSAGE = "every order key is in use";

export function programAddresses(programId: PublicKey): Addresses {
  return new Addresses(programId);
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
 * the slower `fromView` search otherwise (first visit on this device, or a
 * checkpoint that did not survive).
 */
export function orderKeysFromCheckpoint(
  seed: Uint8Array,
  view: Pick<View, "orderKeys">,
  checkpoint: OrderKeyCheckpoint | null,
): OrderKeyManager {
  return checkpoint
    ? OrderKeyManager.restore(seed, view, checkpoint)
    : OrderKeyManager.fromView(seed, view);
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
    options: { expirySeconds?: number; riskMarkets?: number[]; pushWaitMs?: number } = {},
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
    riskMarkets: number[],
    expirySeconds?: number,
  ): Promise<OrderResult & Timing> {
    return this.inner.transferBetweenBalances(
      toCollateral,
      spotToken,
      amount,
      riskMarkets,
      expirySeconds,
    );
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
