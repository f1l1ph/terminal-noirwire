import type { Attention } from "./attention";
import { atomsText } from "./amount";
import type { DepositInput, DepositOutcome } from "./deposit";
import { isKeySweep, type OperationRecord } from "./journal";
import type { TransferEnv } from "./operation";
import type { ReturnInput } from "./returnToWallet";
import type { WithdrawInput, WithdrawOutcome } from "./withdraw";

export interface ResumeFlows {
  deposit(env: TransferEnv, input: DepositInput): Promise<DepositOutcome>;
  withdraw(env: TransferEnv, input: WithdrawInput): Promise<WithdrawOutcome>;
  returnToWallet(env: TransferEnv, input: ReturnInput): Promise<WithdrawOutcome>;
}

/**
 * Carries an open record on by running its own flow with the record's own
 * kind and amount. The form's balance and free-collateral limits are not
 * applied: the first step already moved the funds they would count, so
 * the wallet may hold none. The flow's own checks all still run, and it
 * judges every earlier send before it builds another.
 */
export function resumeRecord(
  env: TransferEnv,
  attention: Pick<Attention, "id" | "operation" | "atoms" | "resumable">,
  freeCollateral: bigint,
  flows: ResumeFlows,
  decimals: number,
): Promise<DepositOutcome | WithdrawOutcome> {
  if (!attention.resumable) {
    return Promise.reject(new Error("This record cannot be carried on from here."));
  }
  if (attention.operation === "return") return giveBack(env, attention, flows);
  const amount = atomsText(BigInt(attention.atoms), decimals);
  const intent = { kind: "resume", id: attention.id, atoms: attention.atoms } as const;
  return attention.operation === "deposit"
    ? flows.deposit(env, { amount, intent })
    : flows.withdraw(env, { amount, freeCollateral, intent });
}

/**
 * Takes the tokens of a deposit record, or carries a return already begun,
 * back to the wallet with the existing return flow, bound to the record's id
 * and amount like every resume. It sends only what the flow's own journal
 * judgement allows, and never repeats a send.
 */
export function giveBack(
  env: TransferEnv,
  attention: Pick<Attention, "id" | "operation" | "atoms" | "resumable"> & { returnable?: boolean },
  flows: Pick<ResumeFlows, "returnToWallet">,
): Promise<WithdrawOutcome> {
  if (!(attention.returnable || (attention.operation === "return" && attention.resumable))) {
    return Promise.reject(new Error("This record cannot be returned to the wallet from here."));
  }
  return flows.returnToWallet(env, { intent: { id: attention.id, atoms: attention.atoms } });
}

/** Whether the Deposit or Withdraw button may be pressed: nothing is running or open, the amount is valid, the account is open, and the account settings are known, which both directions need. */
export const canStartTransfer = (state: {
  running: boolean;
  blocked: boolean;
  amountOk: boolean;
  accountOpen: boolean;
  settingsKnown: boolean;
}): boolean =>
  !state.running && !state.blocked && state.amountOk && state.accountOpen && state.settingsKnown;

/** The open records the user is shown and that hold a new transfer back: the key's routine return of spare SOL is neither, since the next transfer judges it first. */
export const openTransfers = <T extends Pick<OperationRecord, "step">>(records: T[]): T[] =>
  records.filter((record) => !isKeySweep(record));

/** A new transfer waits while any shown record is open, or while the records cannot be read. */
export const newTransferBlocked = (
  records: Pick<OperationRecord, "step">[],
  unreadable: boolean,
): boolean => unreadable || openTransfers(records).length > 0;
