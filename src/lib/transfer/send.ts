import {
  toSolanaSend,
  type Journal,
  type JournalSend,
  type OperationInput,
  type SendLeg,
} from "./journal";
import { solanaVerdict, type SolanaReader, type SolanaVerdict } from "./verdicts";

/**
 * Judges a journaled send. The verdict reads the journal's own status, and a
 * fresh sighting as processed is written back before the verdict is returned,
 * so a crash right after cannot lose it.
 */
export async function judgeSend({
  journal,
  owner,
  id,
  connection,
  send,
  answer,
  clock,
}: {
  journal: Pick<Journal, "markSeen">;
  owner: string;
  id: string;
  connection: SolanaReader;
  send: JournalSend;
  answer?: string;
  /** Lets a send seen and since missing be looked at twice, apart; without it such a send stays unresolved. */
  clock?: { sleep(ms: number): Promise<void> };
}): Promise<SolanaVerdict> {
  const seen = toSolanaSend(send);
  const verdict = await solanaVerdict(connection, seen, answer, clock);
  if (seen.everProcessed && send.status === undefined) {
    await journal.markSeen(owner, id, send.signature, "processed");
  }
  return verdict;
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** `bytes` as base58, which is how Solana writes a signature. */
export function base58Of(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  const digits: number[] = [];
  for (const byte of bytes.subarray(zeros)) {
    let carry = byte;
    for (let place = 0; place < digits.length; place += 1) {
      carry += digits[place] * 256;
      digits[place] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  return `${"1".repeat(zeros)}${digits
    .reverse()
    .map((digit) => BASE58[digit])
    .join("")}`;
}

const SIGNATURE_BYTES = 64;

/** The transaction's own first signature, read from the signed wire bytes. */
export function signatureOf(signedTx: Uint8Array): string {
  const count = signedTx[0];
  if (!count || count >= 0x80 || signedTx.length < 1 + SIGNATURE_BYTES) {
    throw new Error("The transaction is not signed");
  }
  const signature = signedTx.subarray(1, 1 + SIGNATURE_BYTES);
  if (signature.every((byte) => byte === 0)) throw new Error("The transaction is not signed");
  return base58Of(signature);
}

/**
 * Writes the send down, and only when that write has completed calls
 * `broadcast`. If the write throws, nothing is broadcast: a send that is not
 * on record could land with no way to find it again.
 */
export async function recordThenBroadcast<T>({
  journal,
  owner,
  op,
  lastValidBlockHeight,
  before,
  moved,
  leg,
  signedTx,
  broadcast,
}: {
  journal: Pick<Journal, "record">;
  owner: string;
  op: Omit<OperationInput, "sends">;
  lastValidBlockHeight: number;
  /** The owner's token account on Solana before this send, and what it moves, in atoms as decimal text. */
  before: string;
  moved: string;
  /** Which step of a deposit through the deposit key this send is, when it is one. */
  leg?: SendLeg;
  signedTx: Uint8Array;
  broadcast: (signedTx: Uint8Array) => Promise<T>;
}): Promise<{ signature: string; result: T }> {
  if (!Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight <= 0) {
    throw new Error("The send has no valid last block height, so it cannot be judged later");
  }
  const signature = signatureOf(signedTx);
  await journal.record(owner, {
    ...op,
    sends: [{ signature, lastValidBlockHeight, before, moved, ...(leg ? { leg } : {}) }],
  });
  return { signature, result: await broadcast(signedTx) };
}
