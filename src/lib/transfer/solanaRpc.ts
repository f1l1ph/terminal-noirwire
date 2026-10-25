import type { AccountInfo, PublicKey, Transaction } from "@solana/web3.js";
import type { SeenStatus } from "./journal";
import type { SolanaReader } from "./verdicts";

/**
 * The HTTP calls the transfers make, a subset of web3.js `Connection` so a
 * real connection satisfies it and a test can fake it. Nothing here
 * subscribes: a websocket that drops says nothing about a send, a poll does.
 */
export interface SolanaRpc extends SolanaReader {
  getSignatureStatuses(
    signatures: string[],
    config: { searchTransactionHistory: boolean },
  ): Promise<{ value: Array<{ err: unknown; confirmationStatus?: string } | null> }>;
  getLatestBlockhash(
    commitment: "confirmed",
  ): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  getAccountInfo(address: PublicKey, commitment?: "confirmed"): Promise<AccountInfo<Buffer> | null>;
  getBalance(address: PublicKey, commitment?: "confirmed"): Promise<number>;
  sendRawTransaction(
    raw: Uint8Array,
    options: { skipPreflight?: boolean; preflightCommitment?: "confirmed" },
  ): Promise<string>;
  simulateTransaction(
    transaction: Transaction,
  ): Promise<{ value: { err: unknown; logs: string[] | null } }>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** A blockhash with the last block height it is valid at, which a send is judged against later. */
export async function freshBlockhash(
  rpc: Pick<SolanaRpc, "getLatestBlockhash">,
): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash("confirmed");
  if (!blockhash || !Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight <= 0) {
    throw new Error("The node gave no usable blockhash, so nothing can be sent");
  }
  return { blockhash, lastValidBlockHeight };
}

const TOKEN_AMOUNT_OFFSET = 64;
const TOKEN_AMOUNT_END = TOKEN_AMOUNT_OFFSET + 8;

/** What a token account holds, and null for one that is not there or not readable: never 0 for unknown. */
export async function readTokenBalance(
  rpc: Pick<SolanaRpc, "getAccountInfo">,
  account: PublicKey,
): Promise<bigint | null> {
  const info = await rpc.getAccountInfo(account, "confirmed");
  if (!info || info.data.length < TOKEN_AMOUNT_END) return null;
  return new DataView(info.data.buffer, info.data.byteOffset).getBigUint64(
    TOKEN_AMOUNT_OFFSET,
    true,
  );
}

/**
 * The error `transaction` would fail with, as JSON text, or null when it would
 * succeed. The transaction is not signed: the node runs it without keeping
 * anything. A node that cannot simulate throws.
 */
export async function simulationError(
  rpc: Pick<SolanaRpc, "simulateTransaction">,
  transaction: Transaction,
): Promise<string | null> {
  const { value } = await rpc.simulateTransaction(transaction);
  return value.err === null || value.err === undefined ? null : JSON.stringify(value.err);
}

/** The program's error number in a failed transaction's error text, or null. */
export function errorCode(error: string): number | null {
  const found = /"Custom":(\d+)/.exec(error);
  return found ? Number(found[1]) : null;
}

/**
 * Reads until the value is truthy or the time is up, which gives null. A read
 * that throws counts as not there yet.
 */
export async function pollUntil<T>(
  read: () => Promise<T | null | undefined | false>,
  clock: Clock,
  timeoutMs: number,
  everyMs: number,
): Promise<T | null> {
  const deadline = clock.now() + timeoutMs;
  for (;;) {
    const value = await read().catch(() => null);
    if (value) return value;
    if (clock.now() >= deadline) return null;
    await clock.sleep(everyMs);
  }
}

export type Confirmation =
  | { state: "confirmed"; seen: SeenStatus }
  /** The node shows it with an error at confirmed or finalized; whether that can still be undone is the verdict's call. */
  | { state: "failed"; seen: SeenStatus; error: string }
  /** Not seen and the blockhash it was signed with is past its last valid height. */
  | { state: "expired"; seen?: SeenStatus }
  | { state: "timeout"; seen?: SeenStatus };

const STATUS_POLL_MS = 1_000;
const REBROADCAST_MS = 4_000;

const asSeen = (status: string | undefined): SeenStatus | undefined =>
  status === "processed" || status === "confirmed" || status === "finalized" ? status : undefined;

/**
 * Polls a signature's status over HTTP until it is confirmed, shown failed,
 * expired or out of time. Sending the same signed bytes again cannot execute
 * twice, so `rebroadcast` resends them while the signature is not yet seen.
 * A status read that fails is not an answer: it is read again.
 */
export async function confirmSignature(
  rpc: SolanaRpc,
  signature: string,
  {
    clock,
    timeoutMs,
    lastValidBlockHeight,
    rebroadcast,
  }: {
    clock: Clock;
    timeoutMs: number;
    lastValidBlockHeight?: number;
    rebroadcast?: Uint8Array;
  },
): Promise<Confirmation> {
  const started = clock.now();
  let lastSent = started;
  let seen: SeenStatus | undefined;
  while (clock.now() - started < timeoutMs) {
    const status = await rpc
      .getSignatureStatuses([signature], { searchTransactionHistory: false })
      .then((reply) => reply.value[0] ?? null)
      .catch(() => undefined);
    if (status) {
      seen = asSeen(status.confirmationStatus) ?? seen;
      if (status.confirmationStatus !== "processed" && seen) {
        return status.err
          ? { state: "failed", seen, error: JSON.stringify(status.err) }
          : { state: "confirmed", seen };
      }
    } else if (status === null && lastValidBlockHeight !== undefined) {
      const height = await rpc.getBlockHeight("confirmed").catch(() => 0);
      if (height > lastValidBlockHeight) return { state: "expired", seen };
    }
    if (rebroadcast && !seen && clock.now() - lastSent >= REBROADCAST_MS) {
      await rpc.sendRawTransaction(rebroadcast, { skipPreflight: true }).catch(() => null);
      lastSent = clock.now();
    }
    await clock.sleep(STATUS_POLL_MS);
  }
  return { state: "timeout", seen };
}
