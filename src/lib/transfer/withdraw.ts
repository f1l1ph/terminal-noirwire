import "../bufferBigInt";
import {
  delegateEphemeralAtaIx,
  initEphemeralAtaIx,
  withdrawSpl,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { Transaction } from "@solana/web3.js";
import type { KeyWithdrawal } from "../trading/types";
import {
  POLL_MS,
  ROLLUP_CONFIRMS_WITHIN_MS,
  rollupSendState,
  SHOWN_IN_ROLLUP_WITHIN_MS,
  ORDER_KEY_WITHDRAWAL_UNPROVEN,
  SOLANA_EXIT_LAMPORTS,
  balanceAccount,
  beginOperation,
  createAssociatedTokenAccountIdempotentIx,
  delegatedTo,
  finishAllWhenFinal,
  finishIfNothingSent,
  finishWhenFinalized,
  holdsSol,
  intentRefusal,
  movingSends,
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
  type Intent,
  type Refused,
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
import { NotDispatched, blockhashOf } from "./keyedWithdrawal";
import { signatureOf } from "./send";
import { tokenAtoms } from "./verdicts";

/** The program's `StalePrice`: the crank's next push mends it. */
const STALE_PRICE = 6038;
/** The program's `NotSeated`: a withdrawal that took everything gives the seat back, so a second one finds the account empty. */
const NOT_SEATED = 6155;

function nothingInAccount(): Refused {
  return refuse(
    "nothing-in-account",
    "Your trading account holds no funds, so there is nothing to withdraw. Nothing was sent.",
  );
}
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
  /** Whether this is a new transfer or the carrying on of a shown record; checked inside the lock. */
  intent?: Intent;
}

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
  if (shown) return null;
  if ((await recordOf(env, id)).sends.length === 0) {
    return refuse(
      "rollup-unreadable",
      "The rollup does not show the owner's token account, so the withdrawal was not started. Nothing was sent.",
    );
  }
  return waiting(id, "The rollup does not yet show the owner's token account.");
}

/**
 * Whether anything signed for an order key's withdrawal is still unresolved,
 * asked before the client's own answer (a refusal, a call that did not run, a
 * packet too large) is acted on: that answer speaks of the attempt the client
 * last watched, and an earlier one it re-signed over may still run. Every
 * journaled attempt is read, the refused ones given up to a minute to reach
 * finalized. `none` means every attempt was refused at finalized or is
 * unable to land (or none was dispatched), and the answer may be acted on; a
 * stop to return means one landed or may still, and nothing is cleared or sent.
 */
async function attemptsUnresolved(env: TransferEnv, id: string): Promise<Stopped | null | "none"> {
  const seatNow = async () => (await recordOf(env, id)).seat;
  if (!(await seatNow())?.attempts?.length) return "none";
  const until = env.clock.now() + ROLLUP_CONFIRMS_WITHIN_MS;
  let state = await rollupSendState(env, (await seatNow())!, id);
  while (state.kind === "pending" && env.clock.now() < until) {
    await env.clock.sleep(POLL_MS);
    state = await rollupSendState(env, (await seatNow())!, id);
  }
  if (state.kind === "failed" || state.kind === "not-seen") return "none";
  const settled = await settledRollupSend(env, id, await seatNow(), true);
  if (settled === "landed") return null;
  if (settled === "none" || (typeof settled === "object" && "failed" in settled)) return "none";
  return settled;
}

/**
 * The seat's withdrawal signed by an order key, with no wallet signature. The
 * trading client builds, signs and sends it, but the key signs here in the
 * browser, so the signed bytes are handed over before they are dispatched and
 * their signature and exact blockhash are written to the record first, one
 * entry for each distinct signed attempt: from then on the send is judged by
 * the status of every attempt like any rollup send. A call that
 * threw having dispatched nothing clears the pending record and refuses; one
 * that threw otherwise, or whose outcome the client could not prove, stays on
 * record and is never sent again. A refusal leaves the key live and moves
 * nothing, and a stale mark is waited out as for a wallet-signed withdrawal.
 */
async function seatWithdrawnByKey(
  env: TransferEnv,
  withdrawByKey: NonNullable<TransferEnv["withdrawByKey"]>,
  id: string,
  atoms: bigint,
  held: bigint,
): Promise<Stopped | null> {
  const owner = env.owner.toBase58();
  await env.journal.recordSeatSend(owner, id, {
    state: "pending",
    at: new Date(env.clock.now()).toISOString(),
    id: env.newId(),
    before: held.toString(),
    signer: "order-key",
  });
  const writeSignature = (raw: Uint8Array) =>
    env.journal.addSeatAttempt(owner, id, {
      signature: signatureOf(raw),
      blockhash: blockhashOf(raw),
    });
  const deadline = env.clock.now() + FRESH_MARK_WITHIN_MS;
  for (;;) {
    let result: KeyWithdrawal;
    try {
      result = await withdrawByKey(atoms, writeSignature);
    } catch (error) {
      if (!(error instanceof NotDispatched)) return waiting(id, ORDER_KEY_WITHDRAWAL_UNPROVEN);
      await env.journal.clearSeatSend(owner, id);
      return refuse("send-failed", "The withdrawal was not sent. Nothing moved. Try again.");
    }
    if (result.kind === "withdrawn") {
      await env.journal.markSeatProven(owner, id);
      return null;
    }
    if (result.kind === "undetermined") return waiting(id, ORDER_KEY_WITHDRAWAL_UNPROVEN);
    const unresolved = await attemptsUnresolved(env, id);
    if (unresolved !== "none") return unresolved;
    if (result.kind === "refused" && result.code === STALE_PRICE && env.clock.now() <= deadline) {
      await env.clock.sleep(FRESH_MARK_POLL_MS);
      continue;
    }
    await env.journal.clearSeatSend(owner, id);
    switch (result.kind) {
      case "didNotRun":
        return refuse(
          "rollup-refused",
          "The withdrawal did not run and can no longer. Nothing moved.",
        );
      case "tooLarge":
        return refuse(
          "rollup-refused",
          "This exchange has more markets than a withdrawal can name in one message, so it cannot be made from here. Nothing was sent.",
        );
      default:
        if (result.code === NOT_SEATED) return nothingInAccount();
        return result.code === STALE_PRICE
          ? refuse(
              "stale-price",
              "The price is stale and no fresh one arrived in time, so the withdrawal is not made. Try again in a few minutes. Nothing moved.",
            )
          : refuse(
              "rollup-refused",
              "The withdrawal was refused: the seat may hold less than that free of margin, or the market may refuse withdrawals now. Nothing moved.",
            );
    }
  }
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
  if (held === null) {
    return refuse(
      "rollup-unreadable",
      "The rollup does not show the owner's token account, so the withdrawal was not started. Nothing was withdrawn.",
    );
  }
  if (env.withdrawByKey) return seatWithdrawnByKey(env, env.withdrawByKey, id, atoms, held);
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
        "simulation-unavailable",
        `The endpoint did not simulate the withdrawal (${(error as Error).message.split("\n")[0]}), so it is not sent. Nothing was sent.`,
      );
    }
    if (failed === null || errorCode(failed) !== STALE_PRICE || env.clock.now() > deadline) break;
    await env.clock.sleep(FRESH_MARK_POLL_MS);
  }
  if (failed !== null) {
    if (errorCode(failed) === NOT_SEATED) return nothingInAccount();
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
  const result = await sentOnRollup(env, sent, env.rollup, id);
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
 * balance to the wallet on Solana, journaled before it is broadcast. It is
 * done once that send is confirmed, which is what its signature's status says
 * and not what the wallet holds, since the wallet may spend the USDC at once.
 * Earlier sends of this operation are judged first, and one that landed is not
 * sent again. The record is closed here when every send is already final, and
 * otherwise by a later look (`finishCompleted`). A refusal here comes after
 * the collateral left the account, so it is marked as the USDC being in the
 * rollup balance. `alsoFinish` is another operation this one settles.
 */
export async function shuttleToWallet(
  env: TransferEnv,
  operation: { id: string; step: string; atoms: bigint; alsoFinish?: string },
  answer: string | undefined,
): Promise<WithdrawOutcome> {
  const outcome = await shuttleLeg(env, operation, answer);
  return outcome.status === "refused" ? { ...outcome, inRollup: true } : outcome;
}

async function shuttleLeg(
  env: TransferEnv,
  operation: { id: string; step: string; atoms: bigint; alsoFinish?: string },
  answer: string | undefined,
): Promise<WithdrawOutcome> {
  const { id, step, atoms } = operation;
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
  await finishAllWhenFinal(env, closingIds(id, operation.alsoFinish));
  return { status: "done", id, atoms, signature: landed.signature };
}

const closingIds = (id: string, alsoFinish: string | undefined) =>
  alsoFinish === undefined ? [id] : [id, alsoFinish];

/**
 * Closes, without being asked, the withdrawals and returns whose Solana send
 * is confirmed and whose records are only waiting for finality, and the
 * deposits whose last step landed. Nothing is sent: a record is closed only
 * where every send of it is final, and one that is not yet is left for the next
 * look. Skipped while a transfer holds the owner's lock.
 */
export function finishCompleted(env: TransferEnv): Promise<void> {
  return underLock(env, async () => {
    const owner = env.owner.toBase58();
    for (const record of await env.journal.unfinished(owner)) {
      if (record.kind === "deposit") {
        if (record.seat?.state === "landed" || record.stranded) {
          await finishWhenFinalized(env, record.id);
        }
        continue;
      }
      if (record.seat?.state === "pending") continue;
      const moving = movingSends(record);
      if (moving.length === 0) continue;
      const settled = await reconciled(env, record.id, moving, undefined);
      if ("status" in settled || !settled.landed) continue;
      await finishAllWhenFinal(
        env,
        closingIds(
          record.id,
          record.step === "return" ? record.id.slice(0, -".return".length) : undefined,
        ),
      );
    }
  }).then(() => undefined);
}

/**
 * Moves `input.amount` of the seat's free collateral to the wallet on Solana:
 * the rollup program's withdrawal into the owner's rollup token account (after
 * making that account where it is missing), then the token program's
 * withdrawal to Solana. A run that finds the rollup step landed sends only the
 * Solana step, and one that cannot tell whether it landed waits. A run that
 * stops having sent nothing that could have moved money drops its record, so
 * it blocks no other transfer.
 */
export function withdraw(env: TransferEnv, input: WithdrawInput): Promise<WithdrawOutcome> {
  return underLock(env, async () => {
    let atoms: bigint;
    try {
      atoms = tokenAtoms(input.amount, env.decimals);
    } catch (error) {
      return refuse("invalid-amount", (error as Error).message);
    }
    const stale = await intentRefusal(env, "withdraw", input.intent);
    if (stale) return stale;
    const begun = await beginOperation(
      env,
      "withdraw",
      atoms,
      input.intent?.kind === "resume" ? input.intent.id : undefined,
    );
    if ("status" in begun) return begun;
    if (!begun.record && input.intent?.kind === "resume") {
      return refuse(
        "record-changed",
        "This transfer sent nothing and is gone, so it is not carried on. Nothing was sent.",
      );
    }
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
    try {
      if (!solanaStepSent) {
        const stopped = await seatWithdrawn(env, id, atoms, input.answer);
        if (stopped) {
          await finishIfNothingSent(env, id);
          return stopped;
        }
      }
    } catch (error) {
      await finishIfNothingSent(env, id);
      throw error;
    }
    return shuttleToWallet(env, { id, step: "withdraw", atoms }, input.answer);
  });
}
