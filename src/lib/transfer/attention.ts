import type { OperationRecord } from "./journal";

/** What a rollup send stands at, as `rollupSendState` judges it from its signature's status. */
export type SeatJudgement = "landed" | "failed" | "pending" | "not-seen" | "unknown";

export type AttentionKind = "waiting" | "not-landed" | "unknown";

/** One unfinished transfer on record, and what the user may do about it. */
export interface Attention {
  id: string;
  kind: AttentionKind;
  /** What the transfer was: a deposit, a withdrawal or the return of a deposit's tokens to the wallet. */
  operation: "deposit" | "withdraw" | "return";
  /** The amount in atoms as decimal text. */
  atoms: string;
  /** The signature to look the transfer up by, when one was written down. */
  signature?: string;
}

/** The actions a record may offer. A resend is never one of them. */
export type RecordAction = "copy-signature" | "dismiss";

const operationOf = (record: OperationRecord): Attention["operation"] =>
  record.step === "return" ? "return" : record.kind;

const lastSignature = (record: OperationRecord): string | undefined =>
  record.sends[record.sends.length - 1]?.signature;

/**
 * How one record is shown. Only a rollup send that is past its blockhash's
 * life and was read as absent is `not-landed`, and only that can be
 * dismissed; one that cannot be placed is `unknown`; everything else is
 * still `waiting`. `seat` is the judgement of the record's pending rollup
 * send, or null when none was made (no pending send, or transfers are off in
 * this build, where nothing can be judged).
 */
export function attentionOf(record: OperationRecord, seat: SeatJudgement | null): Attention {
  const base = { id: record.id, operation: operationOf(record), atoms: record.atoms };
  const pending = record.seat?.state === "pending" ? record.seat : undefined;
  if (pending && seat === "not-seen") {
    return { ...base, kind: "not-landed", signature: pending.signature };
  }
  if (pending && seat === "unknown") {
    return { ...base, kind: "unknown", signature: pending.signature };
  }
  return { ...base, kind: "waiting", signature: pending?.signature ?? lastSignature(record) };
}

/** What a record offers: the signature to copy when it has one, and Dismiss for a send that did not land and nothing else. */
export function actionsOf(attention: Attention): RecordAction[] {
  const actions: RecordAction[] = attention.signature ? ["copy-signature"] : [];
  if (attention.kind === "not-landed") actions.push("dismiss");
  return actions;
}

/** A signature shortened for a line of text: its first and last characters. */
export function shortSignature(signature: string): string {
  return signature.length <= 16 ? signature : `${signature.slice(0, 8)}...${signature.slice(-8)}`;
}
