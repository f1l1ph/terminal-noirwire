import {
  delegateEphemeralAtaIx,
  initEphemeralAtaIx,
  withdrawSpl,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { Transaction } from "@solana/web3.js";
import type { OperationRecord } from "./journal";
import {
  POLL_MS,
  SHOWN_IN_ROLLUP_WITHIN_MS,
  SOLANA_ARRIVES_WITHIN_MS,
  SOLANA_EXIT_LAMPORTS,
  balanceAccount,
  beginOperation,
  createAssociatedTokenAccountIdempotentIx,
  delegatedTo,
  holdsSol,
  operationFinal,
  reconciled,
  recordOf,
  refuse,
  sendJournaled,
  sentOnRollup,
  settledRollupSend,
  signedAndRecordedOnRollup,
  underLock,
  waiting,
  walletAccount,
  withdrawInstruction,
  type Stopped,
  type TransferEnv,
} from "./operation";
import {
  errorCode,
  freshBlockhash,
  pollUntil,
  readTokenBalance,
  simulationError,
} from "./solanaRpc";
import { tokenAtoms } from "./verdicts";

/** The program's `StalePrice`: the crank's next push mends it. */
const STALE_PRICE = 6038;
/** Longer than the crank's push interval, so a mark that has just gone stale is waited out. */
export const FRESH_MARK_WITHIN_MS = 240_000;
export const FRESH_MARK_POLL_MS = 10_000;

export type WithdrawOutcome =
  Stopped | { status: "done"; id: string; atoms: bigint; signature: string };

export interface WithdrawInput {
  /** What the owner typed, in whole tokens. */
  amount: string;
  /** What the seat holds free of margin, in atoms, as the caller reads it. */
  freeCollateral: bigint;
  /** The operator's answer for a send that was asked about: `landed:<id>` or `lost:<id>`. */
  answer?: string;
}

/** The sends of an operation that move the tokens on Solana, as opposed to a token account's setup, which moves none. */
const movingSends = (record: Pick<OperationRecord, "sends" | "atoms"> | undefined) =>
  (record?.sends ?? []).filter((send) => send.moved === record?.atoms);

/** The operation's record, or nothing before its first send was written. */
const recordedOrNone = async (env: TransferEnv, id: string) =>
  (await env.journal.unfinished(env.owner.toBase58())).find((record) => record.id === id);

/**
 * Makes the owner's token account show in the rollup, which the program's
 * withdrawal checks before anything else: the balance is created on Solana and
 * delegated, or only delegated when it was handed back, or waited for when it
 * is delegated already. A balance delegated to another validator is refused.
 */
async function balanceInRollup(
  env: TransferEnv,
  id: string,
  atoms: bigint,
  answer: string | undefined,
): Promise<Stopped | null> {
  const record = await recordOf(env, id);
  const settled = await reconciled(
    env,
    id,
    record.sends.filter((send) => send.moved === "0"),
    answer,
  );
  if ("status" in settled) return settled;
  const balance = balanceAccount(env);
  const delegated = await delegatedTo(env);
  if (delegated && !delegated.equals(env.validator)) {
    return refuse(
      "delegated-elsewhere",
      `The owner's balance is delegated to ${delegated.toBase58()}, not to this rollup (${env.validator.toBase58()}). Nothing was sent.`,
    );
  }
  if (!delegated) {
    if (env.sealed) {
      return refuse(
        "sealed-balance-missing",
        "The wallet has no token account in the rollup for the withdrawal to pay into, and this custody is sealed, so one cannot be made here. Deposit a little first to make it. Nothing was sent.",
      );
    }
    const exists = (await env.solana.getAccountInfo(balance, "confirmed")) !== null;
    const sent = await sendJournaled(env, {
      id,
      kind: "withdraw",
      step: "withdraw",
      atoms,
      instructions: exists
        ? [delegateEphemeralAtaIx(env.owner, balance, env.validator)]
        : [
            createAssociatedTokenAccountIdempotentIx(
              env.owner,
              walletAccount(env),
              env.owner,
              env.mint,
            ),
            initEphemeralAtaIx(balance, env.owner, env.mint, env.owner),
            delegateEphemeralAtaIx(env.owner, balance, env.validator),
          ],
      shape: { kind: "setup" },
      before: 0n,
      moved: 0n,
    });
    if ("status" in sent) return sent;
    const after = await reconciled(
      env,
      id,
      (await recordOf(env, id)).sends.filter((send) => send.moved === "0"),
      answer,
    );
    if ("status" in after) return after;
    if (!after.landed) {
      return refuse(
        "send-failed",
        "Making the token account did not land and cannot any more. Try again.",
      );
    }
  }
  const shown = await pollUntil(
    async () => (await env.rollup.getAccountInfo(walletAccount(env), "confirmed")) !== null,
    env.clock,
    SHOWN_IN_ROLLUP_WITHIN_MS,
    POLL_MS,
  );
  return shown ? null : waiting(id, "The rollup does not yet show the owner's token account.");
}

/**
 * The seat's withdrawal into the owner's token account in the rollup, once:
 * not again where the record shows it landed or the rollup shows the balance
 * rose by it, and not again until an earlier send is proven unable to land.
 * Simulated first, a stale mark waited out, and recorded with its signature and
 * blockhash expiry before it is sent.
 */
async function seatWithdrawn(
  env: TransferEnv,
  id: string,
  atoms: bigint,
  answer: string | undefined,
): Promise<Stopped | null> {
  const owner = env.owner.toBase58();
  const wallet = walletAccount(env);
  const seat = (await recordOf(env, id)).seat;
  const settled = await settledRollupSend(env, id, seat, true);
  if (settled === "landed") return null;
  if (typeof settled === "object" && "failed" in settled) {
    return refuse(
      "rollup-refused",
      `The withdrawal was refused: ${settled.failed}. Nothing moved, and nothing was sent again.`,
    );
  }
  if (settled !== "none") return settled;

  const missing = await balanceInRollup(env, id, atoms, answer);
  if (missing) return missing;
  const held = await readTokenBalance(env.rollup, wallet);
  if (held === null) return waiting(id, "The rollup does not show the owner's token account.");
  const marketIds = await env.exchange.perpMarketIds();
  const withdrawal = withdrawInstruction(env, atoms, marketIds);
  const deadline = env.clock.now() + FRESH_MARK_WITHIN_MS;
  let failed: string | null;
  for (;;) {
    const { blockhash, lastValidBlockHeight } = await freshBlockhash(env.rollup);
    const simulated = new Transaction({ feePayer: env.owner, blockhash, lastValidBlockHeight }).add(
      withdrawal,
    );
    try {
      failed = await simulationError(env.rollup, simulated);
    } catch (error) {
      return refuse(
        "simulation-failed",
        `The endpoint did not simulate the withdrawal (${(error as Error).message.split("\n")[0]}), so it is not sent. Nothing was sent.`,
      );
    }
    if (failed === null || errorCode(failed) !== STALE_PRICE || env.clock.now() > deadline) break;
    await env.clock.sleep(FRESH_MARK_POLL_MS);
  }
  if (failed !== null) {
    return errorCode(failed) === STALE_PRICE
      ? refuse(
          "stale-price",
          "The price is stale and no fresh one arrived in time, so the withdrawal is not sent. Try again in a few minutes. Nothing was sent.",
        )
      : refuse(
          "rollup-refused",
          `The withdrawal would fail with ${failed}, so it is not sent: the seat may hold less than that free of margin, or the market may refuse withdrawals now. Nothing was sent.`,
        );
  }

  const sent = await signedAndRecordedOnRollup(
    env,
    id,
    [withdrawal],
    { kind: "seat-withdraw", atoms, marketIds },
    held,
  );
  if ("status" in sent) return sent;
  const result = await sentOnRollup(env, sent);
  if (result.state === "failed") {
    await env.journal.clearSeatSend(owner, id);
    return refuse("rollup-refused", `The withdrawal was refused: ${result.error}. Nothing moved.`);
  }
  if (result.state === "unconfirmed") {
    return waiting(
      id,
      "The seat's withdrawal was sent but its status did not show in time. It is judged from the rollup's status next time; it is never sent again.",
    );
  }
  await env.journal.markSeatLanded(owner, id);
  const final = await settledRollupSend(env, id, (await recordOf(env, id)).seat, true);
  if (final === "landed") return null;
  if (final === "none") return waiting(id, "The seat's withdrawal is not on record yet.");
  if ("failed" in final) {
    return refuse("rollup-refused", `The withdrawal was refused: ${final.failed}. Nothing moved.`);
  }
  return final;
}

/**
 * The token program's withdrawal of exactly `atoms` from the owner's rollup
 * balance to the wallet on Solana, journaled before it is broadcast, then
 * waits for the wallet to show it. Earlier sends of this operation are judged
 * first, and one that landed is not sent again: only its arrival is checked.
 * `alsoFinish` is another operation this one settles.
 */
export async function shuttleToWallet(
  env: TransferEnv,
  operation: { id: string; step: string; atoms: bigint; alsoFinish?: string },
  answer: string | undefined,
): Promise<WithdrawOutcome> {
  const { id, step, atoms } = operation;
  const owner = env.owner.toBase58();
  const wallet = walletAccount(env);
  const settled = await reconciled(env, id, movingSends(await recordedOrNone(env, id)), answer);
  if ("status" in settled) return settled;
  let landed = settled.landed;
  if (!landed) {
    const short = await holdsSol(env, SOLANA_EXIT_LAMPORTS);
    if (short) return short;
    // A wallet with no token account yet holds nothing, and this send makes the account.
    const before = (await readTokenBalance(env.solana, wallet)) ?? 0n;
    const sent = await sendJournaled(env, {
      id,
      kind: "withdraw",
      step,
      atoms,
      instructions: await withdrawSpl(env.owner, env.mint, atoms, {
        validator: env.validator,
        payer: env.owner,
        initAtasIfMissing: true,
      }),
      shape: { kind: "exit", atoms },
      before,
      moved: atoms,
    });
    if ("status" in sent) return sent;
    const after = await reconciled(env, id, movingSends(await recordedOrNone(env, id)), answer);
    if ("status" in after) return after;
    landed = after.landed;
    if (!landed) {
      return refuse(
        "send-failed",
        "The withdrawal to the wallet did not land and cannot any more. Try again.",
      );
    }
  }
  const expected = BigInt(landed.before) + BigInt(landed.moved);
  const arrived = await pollUntil(
    async () => {
      const now = await readTokenBalance(env.solana, wallet);
      return now !== null && now >= expected ? now : null;
    },
    env.clock,
    SOLANA_ARRIVES_WITHIN_MS,
    POLL_MS,
  );
  if (arrived === null) {
    return waiting(
      id,
      `The withdrawal ${landed.signature} landed but the wallet does not yet show ${expected} atoms. Nothing more is sent; only its arrival is checked.`,
    );
  }
  const closing = (await env.journal.unfinished(owner)).filter(
    (record) => record.id === id || record.id === operation.alsoFinish,
  );
  for (const record of closing) {
    if (!(await operationFinal(env, record))) {
      return waiting(
        id,
        `The withdrawal ${landed.signature} arrived but a send of this operation is not yet finalized, so its record stays. Nothing more is sent.`,
      );
    }
  }
  for (const record of closing) await env.journal.finish(owner, record.id);
  return { status: "done", id, atoms, signature: landed.signature };
}

/**
 * Moves `input.amount` of the seat's free collateral to the wallet on Solana:
 * the rollup program's withdrawal into the owner's rollup token account (after
 * making that account where it is missing), then the token program's
 * withdrawal to Solana. A run that finds the rollup step landed sends only the
 * Solana step, and one that cannot tell whether it landed asks.
 */
export function withdraw(env: TransferEnv, input: WithdrawInput): Promise<WithdrawOutcome> {
  return underLock(env, async () => {
    let atoms: bigint;
    try {
      atoms = tokenAtoms(input.amount, env.decimals);
    } catch (error) {
      return refuse("invalid-amount", (error as Error).message);
    }
    const begun = await beginOperation(env, "withdraw", atoms);
    if ("status" in begun) return begun;
    const { id, record } = begun;
    const solanaStepSent = movingSends(record ?? undefined).length > 0;
    if (!record?.seat && !solanaStepSent) {
      if (atoms > input.freeCollateral) {
        return refuse(
          "above-free-collateral",
          `The seat holds ${input.freeCollateral} atoms free to withdraw, fewer than the ${atoms} asked for. Nothing was sent.`,
        );
      }
      if (!(await env.exchange.accountOpen())) {
        return refuse(
          "account-not-open",
          "This wallet has no open account on the exchange, so there is nothing to withdraw. Nothing was sent.",
        );
      }
      const short = await holdsSol(env, SOLANA_EXIT_LAMPORTS);
      if (short) return short;
      if (!record) {
        await env.journal.record(env.owner.toBase58(), {
          id,
          kind: "withdraw",
          atoms: atoms.toString(),
          step: "withdraw",
          sends: [],
        });
      }
    }
    if (!solanaStepSent) {
      const stopped = await seatWithdrawn(env, id, atoms, input.answer);
      if (stopped) return stopped;
    }
    return shuttleToWallet(env, { id, step: "withdraw", atoms }, input.answer);
  });
}
