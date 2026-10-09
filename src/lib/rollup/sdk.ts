/**
 * The ONLY module that imports `@noirwire/orderbook`. Everything else in
 * `src/lib/rollup` and `src/lib/trading` sees the plain types re-exported or
 * defined here, so a client package upgrade is an edit to this one file.
 * Mirrors the same discipline sim-noirwire's own `src/rollup/program.ts`
 * follows for the same package (see that repo's docs/DESIGN.md, "The rollup
 * venue"). Currently on 0.3.0.
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  Addresses,
  OrderInvalid as SdkOrderInvalid,
  OrderKeyManager,
  ORDER_TYPE,
  PROGRAM_ID,
  RESULT_STATUS,
  ROLE,
  SIDE,
  TraderClient as SdkTraderClient,
  TransactionFailed as SdkTransactionFailed,
  decodeExchange,
  decodeMarket,
  decodeView,
  privateConnection,
  randomSecret,
  receipt as sdkReceipt,
  signIn as sdkSignIn,
  websocketUrl,
  type OrderKeyCheckpoint,
  type OrderResult,
  type Placed,
  type SignMessage,
  type Timing,
  type View,
} from "@noirwire/orderbook";

export type { View, OrderResult, Placed, SignMessage, Timing, OrderKeyCheckpoint, OrderKeyManager };
export { randomSecret, PROGRAM_ID };
export const OrderInvalid = SdkOrderInvalid;
export const TransactionFailed = SdkTransactionFailed;

export function programAddresses(programId: PublicKey): Addresses {
  return new Addresses(programId);
}

export function connectionTo(rpcUrl: string, wsUrl: string): Connection {
  return new Connection(rpcUrl, { commitment: "confirmed", wsEndpoint: wsUrl });
}

export async function signInAndConnect(
  privateUrl: string,
  reader: PublicKey,
  signMessage: SignMessage,
): Promise<Connection> {
  return privateConnection(privateUrl, reader, signMessage);
}

export { websocketUrl };

export function freshOrderKeys(seed: Uint8Array): OrderKeyManager {
  return OrderKeyManager.fresh(seed);
}

export function orderKeysFromView(
  seed: Uint8Array,
  view: Pick<View, "orderKeys">,
): OrderKeyManager {
  return OrderKeyManager.fromView(seed, view);
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
  ) {
    this.inner = new SdkTraderClient(connection, reader, owner, keys, programId);
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
    options: { expirySeconds?: number; riskMarkets?: number[] } = {},
  ): Promise<Placed> {
    return this.inner.placeOrder(marketId, order, options);
  }

  cancelOrder(
    marketId: number,
    orderSeq: bigint,
    expirySeconds?: number,
  ): Promise<(OrderResult & Timing) | null> {
    return this.inner.cancelOrder(marketId, orderSeq, expirySeconds);
  }

  cancelAll(marketId: number, expirySeconds?: number): Promise<(OrderResult & Timing) | null> {
    return this.inner.cancelAll(marketId, undefined, expirySeconds);
  }

  syncView(marketId: number, expirySeconds?: number): Promise<(OrderResult & Timing) | null> {
    return this.inner.syncView(marketId, expirySeconds);
  }

  transferBetweenBalances(
    toCollateral: boolean,
    spotToken: number,
    amount: bigint,
    riskMarkets: number[],
    expirySeconds?: number,
  ): Promise<(OrderResult & Timing) | null> {
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
export const FILL_ROLE_CODE = ROLE;

export function decodeExchangeAccount(data: Uint8Array) {
  return decodeExchange(data);
}

export function decodeViewAccount(data: Uint8Array): View {
  return decodeView(data);
}

export function decodeMarketAccount(data: Uint8Array) {
  return decodeMarket(data);
}

/** The maker/taker receipt for one of this browser's own order secrets at a given fill. */
export function fillReceipt(
  secret: Uint8Array,
  fillSeq: bigint,
  role: "maker" | "taker",
): Uint8Array {
  return sdkReceipt(secret, fillSeq, role === "maker" ? ROLE.maker : ROLE.taker);
}

export async function signIn(
  privateUrl: string,
  reader: PublicKey,
  signMessage: SignMessage,
): Promise<string> {
  return sdkSignIn(privateUrl, reader, signMessage);
}

export { Keypair };
