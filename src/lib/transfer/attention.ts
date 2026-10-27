import type { OperationRecord } from "./journal";

/** What a rollup send stands at, as `rollupSendState` judges it from its signature's status. */
export type SeatJudgement = "landed" | "failed" | "pending" | "not-seen" | "unreadable" | "unknown";

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
  /** Whether the flow can carry this record on: not one that did not land, cannot be placed, is still settling on the rollup, or is a return. */
  resumable: boolean;
  /** Whether the deposit's tokens may be taken back to the wallet: a deposit record, from before deposits went through a deposit key, with no rollup send still settling. */
  returnable: boolean;
  /** Whether the deposit's tokens went into the rollup as the deposit key's balance, where "try the deposit again" is their way into the account. */
  keyed: boolean;
  /** Whether the program refused the deposit's last step for good, so its USDC waits in the deposit key's rollup balance and only the move into the rollup is left to settle. */
  stranded: boolean;
}

/** Whether a deposit is between its first step and its last: its record is written before the first send and removed when it finishes. */
export const depositInProgress = (records: readonly OperationRecord[]): boolean =>
  records.some((record) => operationOf(record) === "deposit");

/**
 * Whether a record is complete and only waiting for its sends to be final: a
 * deposit whose last step landed or was refused for good (stranded), or a
 * withdrawal or return whose Solana send was made and has no rollup send still
 * unproven. Closing it needs no click.
 */
export const awaitsFinality = (record: OperationRecord): boolean =>
  record.kind === "deposit"
    ? record.seat?.state === "landed" || record.stranded === true
    : record.seat?.state !== "pending" && record.sends.some((send) => send.moved === record.atoms);

/** The actions a record may offer. A resend is never one of them: resuming runs the flow, which judges every earlier send first. */
export type RecordAction = "copy-signature" | "dismiss" | "resume" | "return";

const operationOf = (record: OperationRecord): Attention["operation"] =>
  record.step === "return" ? "return" : record.kind;

const lastSignature = (record: OperationRecord): string | undefined =>
  record.sends[record.sends.length - 1]?.signature;

/**
 * How one record is shown. Only a rollup send that is past its blockhash's
 * life and was read as absent is `not-landed`, and only that can be
 * dismissed; one that cannot be placed is `unknown`; everything else is
 * still `waiting`, and one whose status could not be read just now can be
 * carried on, which only reads it again. `seat` is the judgement of the record's pending rollup
 * send, or null when none was made (no pending send, or transfers are off in
 * this build, where nothing can be judged).
 */
export function attentionOf(
  record: OperationRecord,
  seat: SeatJudgement | null,
  all: readonly OperationRecord[] = [],
): Attention {
  const operation = operationOf(record);
  const behindReturn = all.some((other) => other.id === `${record.id}.return`);
  const base = {
    id: record.id,
    operation,
    atoms: record.atoms,
    keyed: operation === "deposit" && record.depositKey !== undefined,
    stranded: record.stranded === true,
  };
  const pending = record.seat?.state === "pending" ? record.seat : undefined;
  if (pending && seat === "not-seen") {
    return {
      ...base,
      kind: "not-landed",
      signature: pending.signature,
      resumable: false,
      returnable: false,
    };
  }
  if (pending && seat === "unknown") {
    return {
      ...base,
      kind: "unknown",
      signature: pending.signature,
      resumable: false,
      returnable: false,
    };
  }
  const settled = !pending || seat === "landed" || seat === "failed";
  return {
    ...base,
    kind: "waiting",
    signature: pending?.signature ?? lastSignature(record),
    resumable: (settled || seat === "unreadable") && !behindReturn,
    returnable:
      settled &&
      operation === "deposit" &&
      !behindReturn &&
      record.seat?.state !== "landed" &&
      record.depositKey === undefined,
  };
}

/**
 * What a record offers: the signature to copy when it has one, and Dismiss for
 * a send that did not land and nothing else. The record of a transfer this tab
 * is running now (`running`) offers nothing to press, since carrying it on
 * would only collide with the run.
 */
export function actionsOf(attention: Attention, running = false): RecordAction[] {
  const actions: RecordAction[] = attention.signature ? ["copy-signature"] : [];
  if (running) return actions;
  if (attention.kind === "not-landed") actions.push("dismiss");
  if (attention.resumable) actions.push("resume");
  if (attention.returnable) actions.push("return");
  return actions;
}

/** A signature shortened for a line of text: its first and last characters. */
export function shortSignature(signature: string): string {
  return signature.length <= 16 ? signature : `${signature.slice(0, 8)}...${signature.slice(-8)}`;
}
