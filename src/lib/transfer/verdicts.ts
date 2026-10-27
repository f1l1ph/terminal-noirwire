const U64_MAX = 2n ** 64n - 1n;

/** What a Solana node answers for a signature; the subset of web3.js `Connection` the verdict reads. */
export interface SolanaReader {
  getSignatureStatus(
    signature: string,
    config: { searchTransactionHistory: boolean },
  ): Promise<{
    /** The slot the node answered at, when it says. */
    context?: { slot: number };
    value: { err: unknown; confirmationStatus?: string } | null;
  }>;
  getBlockHeight(commitment: "confirmed" | "finalized"): Promise<number>;
  getSlot(commitment: "finalized"): Promise<number>;
}

/** One Solana transaction written down before it was broadcast. */
export interface SolanaSend {
  signature: string;
  /** After this block height the transaction can no longer land. */
  lastValidBlockHeight: number;
  /** Set once any read saw it as processed: it is then never dropped on a later missing status. */
  everProcessed?: boolean;
}

/** A rollup send recorded before it was made: `pending` until shown to have landed. */
export interface SentRecord {
  state: "pending" | "landed";
  at: string;
  id?: string;
}

/** The seat's withdrawal into the rollup, with the owner's rollup balance before it, in atoms as decimal text. */
export type SeatSend = SentRecord & {
  before: string;
  /**
   * Set when the deposit key, not the owner, signed it: its status is read through the deposit key's own rollup session.
   * `order-key` is a withdrawal an order key signed through the client: the client may sign it more than once, so it is
   * judged by every signed attempt in `attempts`, each written down just before it was dispatched.
   */
  signer?: "deposit-key" | "order-key";
  /** The rollup transaction's signature and the last block height of its blockhash, written before it was sent, so a later read can prove it can no longer land. For an order key's withdrawal, the latest attempt's signature, for showing. */
  signature?: string;
  lastValidBlockHeight?: number;
  /** Set once any read has seen the rollup transaction at processed or better: from then on a missing status is never taken as proof that it cannot land. */
  seen?: true;
  /** Set only when the trading client proved an order key's withdrawal from the account's own view: then it is final as recorded. A landed seat without it was shown by a status and is final only at a finalized success. */
  proven?: true;
  /** Every distinct signed attempt of an order key's withdrawal. It is safe to clear only when every one is shown unable to land, and it landed if any one did. */
  attempts?: SeatAttempt[];
};

/** One signed transaction of an order key's withdrawal, judged by whether its exact blockhash is still valid. */
export interface SeatAttempt {
  signature: string;
  blockhash: string;
  /** Set once a read has seen it at processed or better. */
  seen?: true;
}

export interface ExitOperation {
  id: string;
  owner: string;
  /** The amount asked for, in atoms as decimal text, and the method. */
  atoms: string;
  method: string;
  seat?: SeatSend;
  solana: SolanaSend[];
}

export type SolanaVerdict = "landed" | "failed" | "safe" | "wait";

const recordId = (record: SentRecord) => record.id ?? record.at;

/**
 * What to do about a recorded send, given the operator's answer for a pending
 * one, `landed:<id>` or `lost:<id>` naming that very record. An answer that
 * names no record, or another one, is no answer.
 */
export function pendingVerdict(
  record: SentRecord | undefined,
  answer: string | undefined,
): "send" | "done" | "ask" {
  if (!record) return "send";
  if (record.state === "landed") return "done";
  const id = recordId(record);
  if (answer === `landed:${id}`) return "done";
  return answer === `lost:${id}` ? "send" : "ask";
}

/**
 * What to do about the seat's withdrawal given the record and the owner's
 * token account in the rollup now: `send` it, take it as `landed` and go on, or
 * `ask`. The rollup balance rising by the amount shows it landed even when the
 * response was lost; otherwise only the operator's answer settles it.
 */
export function seatVerdict(
  seat: SeatSend | undefined,
  atoms: bigint,
  rollupNow: bigint,
  answer: string | undefined,
): "send" | "landed" | "ask" {
  if (!seat) return "send";
  if (seat.state === "landed") return "landed";
  if (rollupNow >= BigInt(seat.before) + atoms) return "landed";
  const verdict = pendingVerdict(seat, answer);
  return verdict === "done" ? "landed" : verdict;
}

/**
 * Where a transaction written down before its broadcast stands: `landed`,
 * `failed` (it ran and was refused, so it moved nothing), `safe` (it is not
 * there and its blockhash has expired, so it can never be included) or `wait`
 * (it may still land). The block height is read before the status, so a
 * transaction that lands between the two reads is seen by the status and never
 * judged unable to land. A send seen as `processed` without an error is marked
 * `everProcessed` (on the send the caller passes, which the caller must save)
 * and is never dropped on a later missing status alone, since a lagging node
 * may answer null for an execution another node saw: it waits until it is
 * confirmed, the operator answers `landed:<signature>`, or the finalized
 * chain is past its blockhash's last valid height and the status is read again
 * (a finalized status is `landed` or `failed`; missing twice, from replies
 * current to the finalized slot, is `safe`).
 * A send is `failed` only on a finalized status that carries an error; an
 * error on a status that is not finalized may still be rolled back, so it
 * waits. A read that fails throws, and nothing is sent on a guess.
 */
export async function solanaVerdict(
  connection: SolanaReader,
  send: SolanaSend,
  answer?: string,
  clock?: { sleep(ms: number): Promise<void> },
): Promise<SolanaVerdict> {
  const height = await connection.getBlockHeight("confirmed");
  const { value } = await connection.getSignatureStatus(send.signature, {
    searchTransactionHistory: true,
  });
  if (value) {
    if (value.err) {
      if (value.confirmationStatus === "finalized") return "failed";
      if (!send.everProcessed) return "wait";
    } else if (value.confirmationStatus !== "processed") {
      return "landed";
    } else {
      send.everProcessed = true;
    }
  }
  if (send.everProcessed) {
    if (answer === `landed:${send.signature}`) return "landed";
    return height > send.lastValidBlockHeight ? finalizedVerdict(connection, send, clock) : "wait";
  }
  return height > send.lastValidBlockHeight ? "safe" : "wait";
}

/** How long apart the two reads are that must both find a seen send missing before it is taken as unable to land. */
export const MISSING_RECHECK_MS = 5_000;

/**
 * One look at a seen send whose blockhash has expired, from the finalized
 * chain: `wait` while the finalized height is not past the limit, and `absent`
 * only when the status is missing from a reply whose context slot is at or past
 * the finalized slot read after that height, so a node whose history lags
 * behind its own finalized height proves nothing.
 */
async function finalizedLook(
  connection: SolanaReader,
  send: SolanaSend,
): Promise<SolanaVerdict | "absent"> {
  const finalizedHeight = await connection.getBlockHeight("finalized");
  if (finalizedHeight <= send.lastValidBlockHeight) return "wait";
  const finalizedSlot = await connection.getSlot("finalized");
  const { context, value } = await connection.getSignatureStatus(send.signature, {
    searchTransactionHistory: true,
  });
  if (!value) return context !== undefined && context.slot >= finalizedSlot ? "absent" : "wait";
  if (value.confirmationStatus === "finalized") return value.err ? "failed" : "landed";
  return !value.err && value.confirmationStatus !== "processed" ? "landed" : "wait";
}

/**
 * The verdict for a send that was seen and whose blockhash has expired: decided
 * only from the finalized chain. Missing counts as `safe` only when two looks,
 * `MISSING_RECHECK_MS` apart, both find it missing in a reply that is current
 * to the finalized slot; without a clock to wait on, or on any other result,
 * it stays unresolved and is looked at again next time.
 */
async function finalizedVerdict(
  connection: SolanaReader,
  send: SolanaSend,
  clock: { sleep(ms: number): Promise<void> } | undefined,
): Promise<SolanaVerdict> {
  const first = await finalizedLook(connection, send);
  if (first !== "absent") return first;
  if (!clock) return "wait";
  await clock.sleep(MISSING_RECHECK_MS);
  const second = await finalizedLook(connection, send);
  return second === "absent" ? "safe" : second;
}

const sentSomething = (operation: ExitOperation) =>
  operation.seat !== undefined || operation.solana.length > 0;

/**
 * The operation to carry on: the one recorded for this owner when it asked for
 * the same amount by the same method, a new one when none was recorded or the
 * recorded one sent nothing, and a refusal when an unfinished one asked for
 * something else, since carrying on with different figures would hide what
 * the first sent.
 */
export function exitOperation(
  recorded: ExitOperation | null,
  asked: { id: string; owner: string; atoms: bigint; method: string },
): ExitOperation {
  if (recorded && sentSomething(recorded)) {
    if (recorded.atoms !== asked.atoms.toString() || recorded.method !== asked.method) {
      throw new Error(
        `An earlier exit of this owner (operation ${recorded.id}) asked for ${recorded.atoms} atoms by ${recorded.method} and sent something that may have landed. Finish it first with that amount and method. Nothing was sent.`,
      );
    }
    return recorded;
  }
  return {
    id: asked.id,
    owner: asked.owner,
    atoms: asked.atoms.toString(),
    method: asked.method,
    solana: [],
  };
}

/**
 * A decimal amount of tokens as atoms. Refused unless it is plainly a number
 * above zero that the token can hold, so 0.0000001 of a token of 6 decimals is
 * not rounded to nothing.
 */
export function tokenAtoms(amount: string, decimals: number): bigint {
  const parts = /^(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!parts) {
    throw new Error(
      `Amount ${amount} is not a number of tokens such as 5 or 0.25. Nothing was sent.`,
    );
  }
  const fraction = parts[2] ?? "";
  if (fraction.length > decimals) {
    throw new Error(
      `Amount ${amount} has more decimal places than the token has (${decimals}). Nothing was sent.`,
    );
  }
  const atoms =
    BigInt(parts[1]) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (atoms === 0n || atoms > U64_MAX) {
    throw new Error(
      `Amount ${amount} is not an amount above zero that a balance can hold. Nothing was sent.`,
    );
  }
  return atoms;
}
