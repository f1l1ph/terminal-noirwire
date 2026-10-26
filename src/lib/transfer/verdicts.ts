const U64_MAX = 2n ** 64n - 1n;

/** What a Solana node answers for a signature; the subset of web3.js `Connection` the verdict reads. */
export interface SolanaReader {
  getSignatureStatus(
    signature: string,
    config: { searchTransactionHistory: boolean },
  ): Promise<{ value: { err: unknown; confirmationStatus?: string } | null }>;
  getBlockHeight(commitment: "confirmed"): Promise<number>;
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
  /** The rollup transaction's signature and the last block height of its blockhash, written before it was sent, so a later read can prove it can no longer land. */
  signature?: string;
  lastValidBlockHeight?: number;
};

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
 * (it may still land). A send seen as `processed` without an error is marked
 * `everProcessed` (on the send the caller passes, which the caller must save)
 * and is never dropped on its own afterwards, whatever a later read says,
 * since a lagging node may answer null for an execution another node saw: it
 * waits until it is confirmed or the operator answers `landed:<signature>`.
 * A send is `failed` only on a finalized status that carries an error; an
 * error on a status that is not finalized may still be rolled back, so it
 * waits. A read that fails throws, and nothing is sent on a guess.
 */
export async function solanaVerdict(
  connection: SolanaReader,
  send: SolanaSend,
  answer?: string,
): Promise<SolanaVerdict> {
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
    return answer === `landed:${send.signature}` ? "landed" : "wait";
  }
  const height = await connection.getBlockHeight("confirmed");
  return height > send.lastValidBlockHeight ? "safe" : "wait";
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
