import {
  SOLANA_EXIT_LAMPORTS,
  currentRecord,
  holdsSol,
  reconciled,
  refuse,
  settledRollupSend,
  underLock,
  walletAccount,
  type TransferEnv,
} from "./operation";
import { isStaged } from "./journal";
import { isKeyReturn, returnFromDepositKey, sendKeyReturn } from "./keyReturn";
import { readTokenBalance } from "./solanaRpc";
import { shuttleToWallet, type WithdrawOutcome } from "./withdraw";

export type ReturnOutcome = WithdrawOutcome;

export interface ReturnInput {
  /** The operator's answer for a send that was asked about: `landed:<id>` or `lost:<id>`. */
  answer?: string;
  /** The record this return is for, checked inside the lock: a screen gone stale in another tab sends nothing. */
  intent?: { id: string; atoms: string };
}

const returnIdOf = (depositId: string) => `${depositId}.return`;

/**
 * Takes back to the wallet the tokens of a deposit through the deposit key
 * that sit in the key's token account on Solana, with a payment signed by the
 * key alone, and the tokens a deposit of an earlier version moved into the
 * rollup when its second step did not land, with the token program's
 * withdrawal, journaled the same way. Only for a deposit whose first step
 * landed and whose second was never sent or was refused: where the second may
 * have landed it asks, and
 * where it did, the deposit is done and there is nothing to return. A return
 * already under way is carried on, never repeated.
 */
export function returnToWallet(env: TransferEnv, input: ReturnInput = {}): Promise<ReturnOutcome> {
  return underLock(env, async () => {
    const owner = env.owner.toBase58();
    const current = currentRecord(await env.journal.unfinished(owner));
    if (input.intent && (current?.id !== input.intent.id || current.atoms !== input.intent.atoms)) {
      return refuse(
        "record-changed",
        "This transfer already finished or changed, perhaps in another tab. Nothing was sent.",
      );
    }
    if (current && isKeyReturn(current)) {
      return sendKeyReturn(env, current.id, current.id.slice(0, -".return".length), input.answer);
    }
    if (current?.step === "return") {
      return shuttleToWallet(
        env,
        {
          id: current.id,
          step: "return",
          atoms: BigInt(current.atoms),
          alsoFinish: current.id.slice(0, -".return".length),
        },
        input.answer,
      );
    }
    if (!current || current.step !== "deposit") {
      return refuse(
        "nothing-to-return",
        "There is no unfinished deposit to return. Nothing was sent.",
      );
    }

    if (isStaged(current)) return returnFromDepositKey(env, current, input.answer);

    const atoms = BigInt(current.atoms);
    const settled = await reconciled(env, current.id, current.sends, input.answer);
    if ("status" in settled) return settled;
    if (!settled.landed) {
      return refuse(
        "nothing-to-return",
        "The deposit's move into the rollup did not land, so there is nothing in the rollup to return. Nothing was sent.",
      );
    }
    const held = await readTokenBalance(env.rollup, walletAccount(env));
    if (held === null) {
      return refuse(
        "rollup-unreadable",
        "The rollup does not show the owner's balance. Nothing was sent.",
      );
    }
    const settledDeposit = await settledRollupSend(env, current.id, current.seat);
    if (settledDeposit === "landed") {
      return refuse(
        "deposit-landed",
        "The deposit into the seat landed, so the tokens are in the seat, not in the rollup balance. Nothing was sent.",
      );
    }
    if (settledDeposit !== "none" && !("failed" in settledDeposit)) return settledDeposit;
    if (held < atoms) {
      return refuse(
        "rollup-short",
        `The owner holds ${held} atoms in the rollup, fewer than the ${atoms} to return. Nothing was sent.`,
      );
    }
    const short = await holdsSol(env, SOLANA_EXIT_LAMPORTS);
    if (short) return short;
    return shuttleToWallet(
      env,
      { id: returnIdOf(current.id), step: "return", atoms, alsoFinish: current.id },
      input.answer,
    );
  });
}
