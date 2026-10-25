import type { Attention } from "./attention";
import { atomsText } from "./amount";
import type { DepositInput, DepositOutcome } from "./deposit";
import type { TransferEnv } from "./operation";
import type { WithdrawInput, WithdrawOutcome } from "./withdraw";

export interface ResumeFlows {
  deposit(env: TransferEnv, input: DepositInput): Promise<DepositOutcome>;
  withdraw(env: TransferEnv, input: WithdrawInput): Promise<WithdrawOutcome>;
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
  attention: Pick<Attention, "operation" | "atoms" | "resumable">,
  freeCollateral: bigint,
  flows: ResumeFlows,
  decimals: number,
): Promise<DepositOutcome | WithdrawOutcome> {
  if (!attention.resumable || attention.operation === "return") {
    return Promise.reject(new Error("This record cannot be carried on from here."));
  }
  const amount = atomsText(BigInt(attention.atoms), decimals);
  return attention.operation === "deposit"
    ? flows.deposit(env, { amount })
    : flows.withdraw(env, { amount, freeCollateral });
}

/** A new transfer waits while any record is open, or while the records cannot be read. */
export const newTransferBlocked = (open: number, unreadable: boolean): boolean =>
  unreadable || open > 0;
