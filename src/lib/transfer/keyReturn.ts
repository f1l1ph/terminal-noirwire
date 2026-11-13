import { atomsText } from "./amount";
import { MAX_KEY_TRANSFER_FEE_LAMPORTS } from "./computeBudget";
import { depositKeyAccount, returnKeyInstructions } from "./depositKey";
import { legSends, type OperationRecord } from "./journal";
import { TOKEN_ACCOUNT_BYTES } from "./keyMoveCost";
import {
  depositKeyMissing,
  finishAllWhenFinal,
  reconciled,
  refuse,
  sendJournaled,
  type Refused,
  type TransferEnv,
} from "./operation";
import { judgeSend } from "./send";
import { readTokenBalance } from "./solanaRpc";
import { associatedTokenAddress } from "./tokenAccounts";
import type { WithdrawOutcome } from "./withdraw";

const RETURN_SUFFIX = ".return";

/** The id of the record of a deposit's return from the deposit key. */
export const keyReturnId = (depositId: string) => `${depositId}${RETURN_SUFFIX}`;

/** Whether a record is the deposit key's payment of its tokens back to the wallet, and not the token program's withdrawal. */
export const isKeyReturn = (record: Pick<OperationRecord, "step" | "sends">): boolean =>
  record.step === "return" && legSends(record, "return").length > 0;

/**
 * The ids of the staged deposits among `records` whose move into the rollup
 * is known to have landed, so their tokens are out of the key's account on
 * Solana. Reads only: a send that cannot be told is not counted.
 */
export async function movedDeposits(
  env: TransferEnv,
  records: readonly OperationRecord[],
): Promise<string[]> {
  const moved: string[] = [];
  for (const record of records) {
    for (const send of legSends(record, "move")) {
      const verdict = await judgeSend({
        journal: env.journal,
        owner: env.owner.toBase58(),
        id: record.id,
        connection: env.solana,
        send,
        clock: env.clock,
      });
      if (verdict === "landed") {
        moved.push(record.id);
        break;
      }
    }
  }
  return moved;
}

const recordNamed = async (env: TransferEnv, id: string) =>
  (await env.journal.unfinished(env.owner.toBase58())).find((candidate) => candidate.id === id);

/**
 * Sends the tokens a staged deposit left in the deposit key's token account on
 * Solana back to the owner's, signed and paid by the key alone, so it works
 * however the key's move into the rollup keeps failing. Only where the funding
 * landed and no move did; a move that may still land stops it, so it can never
 * repeat a send whose outcome is uncertain. Closes nothing: the key's token
 * account stays.
 */
export async function returnFromDepositKey(
  env: TransferEnv,
  deposit: OperationRecord,
  answer: string | undefined,
): Promise<WithdrawOutcome> {
  if (deposit.depositKey !== env.depositKey.publicKey.toBase58()) {
    return depositKeyMissing(deposit.id);
  }
  const funded = await reconciled(env, deposit.id, legSends(deposit, "fund"), answer);
  if ("status" in funded) return funded;
  if (!funded.landed) {
    return refuse(
      "nothing-to-return",
      "The payment to the deposit key did not land, so it holds nothing to send back. Nothing was sent.",
    );
  }
  const moved = await reconciled(env, deposit.id, legSends(deposit, "move"), answer);
  if ("status" in moved) return moved;
  if (moved.landed) {
    return refuse(
      "key-moved",
      "The USDC already moved into the rollup, so it cannot be sent back from here. Nothing was sent.",
    );
  }
  return sendKeyReturn(env, keyReturnId(deposit.id), deposit.id, answer);
}

/**
 * Refuses when the owner's token account is gone and the deposit key cannot
 * pay for making it again: its rent, the return's fee and the rent of the
 * key's own empty account must all be in the key, or the network would refuse
 * the return. Null when the account exists, or the key can afford it.
 */
async function lacksSolForReturn(env: TransferEnv, depositId: string): Promise<Refused | null> {
  const account = await env.solana.getAccountInfo(
    associatedTokenAddress(env.owner, env.mint),
    "confirmed",
  );
  if (account) return null;
  const [rent, own, held] = await Promise.all([
    env.solana.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_BYTES),
    env.solana.getMinimumBalanceForRentExemption(0),
    env.solana.getBalance(env.depositKey.publicKey, "confirmed"),
  ]);
  const needed = rent + own + MAX_KEY_TRANSFER_FEE_LAMPORTS;
  return held >= needed
    ? null
    : refuse(
        "key-needs-sol",
        `Your USDC token account in the wallet was closed, and the deposit key holds ${held} lamports of SOL, fewer than the ${needed} it needs to make it again and send your USDC back. Nothing was sent. Contact support with the transfer id ${depositId}.`,
      );
}

/**
 * Carries the deposit key's return on: a send of it already on record is
 * judged first, and only where none landed and none can any more is the key's
 * balance paid back again. When it landed, its record and the deposit's close
 * once every send of both is final.
 */
export async function sendKeyReturn(
  env: TransferEnv,
  returnId: string,
  depositId: string,
  answer: string | undefined,
): Promise<WithdrawOutcome> {
  const record = await recordNamed(env, returnId);
  const settled = await reconciled(env, returnId, record?.sends ?? [], answer);
  if ("status" in settled) return settled;
  let landed = settled.landed;
  if (!landed) {
    const key = env.depositKey.publicKey;
    const held = await readTokenBalance(env.solana, depositKeyAccount(key, env.mint));
    const atoms = record ? BigInt(record.atoms) : held;
    if (held === null || atoms === null || atoms === 0n || held === 0n) {
      return refuse(
        "key-empty",
        "The deposit key holds no USDC on Solana to send back. Nothing was sent.",
      );
    }
    if (held < atoms) {
      return refuse(
        "key-short",
        `The deposit key holds ${atomsText(held, env.decimals)} USDC on Solana, less than the ${atomsText(atoms, env.decimals)} to send back, so nothing is sent. Contact support with the transfer id ${depositId}.`,
      );
    }
    const short = await lacksSolForReturn(env, depositId);
    if (short) return short;
    const sent = await sendJournaled(env, {
      id: returnId,
      kind: "withdraw",
      step: "return",
      atoms,
      instructions: returnKeyInstructions({
        owner: env.owner,
        key,
        mint: env.mint,
        decimals: env.decimals,
        atoms,
      }),
      shape: { kind: "key-return", atoms, key, decimals: env.decimals },
      leg: "return",
      before: held,
      moved: atoms,
    });
    if ("status" in sent) return sent;
    const after = await reconciled(
      env,
      returnId,
      (await recordNamed(env, returnId))?.sends ?? [],
      answer,
    );
    if ("status" in after) return after;
    if (!after.landed) {
      return refuse(
        "send-failed",
        "The payment back to the wallet did not land and cannot any more. Your USDC is still in the deposit key. Try again.",
      );
    }
    landed = after.landed;
  }
  await finishAllWhenFinal(env, [returnId, depositId]);
  return {
    status: "done",
    id: returnId,
    atoms: BigInt(landed.moved),
    signature: landed.signature,
  };
}
