import {
  delegateEataPermissionIx,
  delegateSpl,
  deriveVault,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  ROUND_TRIP_LAMPORTS,
  POLL_MS,
  balanceAccount,
  beginOperation,
  custodyAccount,
  depositInstruction,
  finishWhenFinalized,
  heldInRollup,
  holdsSol,
  intentRefusal,
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
  type Intent,
  type Refused,
  type Stopped,
  type TransferEnv,
} from "./operation";
import { withComputeBudget } from "./computeBudget";
import { errorCode, pollUntil, readTokenBalance } from "./solanaRpc";
import { tokenAtoms } from "./verdicts";

const CUSTODY_CAP_REACHED = 6150;
const NO_SEAT = 6114;
const DELEGATION_SHOWN_WITHIN_MS = 60_000;

export type DepositOutcome =
  | Stopped
  | {
      status: "done";
      id: string;
      atoms: bigint;
      /** The deposit is in the seat; the caller refreshes its view. */
      next: "syncView";
    }
  | {
      /** The move into the rollup landed and the deposit was refused: the tokens sit in the owner's rollup balance. Retry the deposit, or return them to the wallet. */
      status: "stranded";
      id: string;
      message: string;
    };

export interface DepositInput {
  /** What the owner typed, in whole tokens. */
  amount: string;
  /** The operator's `landed:<signature>` for a Solana send seen as processed and since missing. A rollup send has no answer: it is judged from the rollup. */
  answer?: string;
  /** Whether this is a new transfer or the carrying on of a shown record; checked inside the lock. */
  intent?: Intent;
}

/**
 * Whether the deposit may start, checked before any signature is asked for:
 * the account is open, the exchange is not paused, custody has room under its
 * cap (read from the custody account itself, equal allowed), and the wallet
 * holds the tokens and the SOL for the steps. A private rollup serves the
 * custody account only to its owner, a program address no reader can sign in
 * as, so there the cap is left to the program: a deposit it refuses leaves the
 * tokens in the owner's rollup balance, from where they can be returned.
 */
async function depositRefusal(
  env: TransferEnv,
  atoms: bigint,
): Promise<Refused | { wallet: bigint }> {
  if (!(await env.exchange.accountOpen())) {
    return refuse(
      "account-not-open",
      "This wallet has no open account on the exchange. Nothing was sent.",
    );
  }
  const exchange = await env.exchange.read();
  if (exchange.paused) {
    return refuse(
      "exchange-paused",
      "The exchange is paused, so it takes no deposit. Nothing was sent.",
    );
  }
  const custody = await readTokenBalance(env.rollup, custodyAccount(env));
  if (custody !== null && custody + atoms > exchange.custodyCap) {
    return refuse(
      "custody-cap",
      `The deposit would take custody to ${custody + atoms} atoms, past the cap of ${exchange.custodyCap}. Nothing was sent.`,
    );
  }
  const wallet = await readTokenBalance(env.solana, walletAccount(env));
  if (wallet === null || wallet < atoms) {
    return refuse(
      "insufficient-usdc",
      `The wallet holds ${wallet ?? 0n} atoms, fewer than the ${atoms} to deposit. Nothing was sent.`,
    );
  }
  const short = await holdsSol(env, ROUND_TRIP_LAMPORTS);
  return short ?? { wallet };
}

/**
 * Step 1: the token program's move of `atoms` into the rollup, with the same
 * options as the operator tools. The rollup balance before it is journaled
 * with the send, so a later run can tell whether it landed.
 */
async function moveIntoRollup(
  env: TransferEnv,
  id: string,
  atoms: bigint,
  wallet: bigint,
): Promise<Refused | null> {
  const balance = balanceAccount(env);
  const first = !(await env.solana.getAccountInfo(balance, "confirmed"));
  const vaultMissing = !(await env.solana.getAccountInfo(deriveVault(env.mint)[0], "confirmed"));
  const rollupBefore = first ? 0n : await heldInRollup(env);
  if (rollupBefore === null) {
    return refuse(
      "rollup-unreadable",
      "The owner's balance is delegated but the rollup does not show it, so the move cannot be checked later. Nothing was sent.",
    );
  }
  const instructions = await delegateSpl(env.owner, env.mint, atoms, {
    validator: env.validator,
    idempotent: !first,
    payer: env.owner,
    initVaultIfMissing: vaultMissing,
    private: env.sealed,
  });
  if (env.sealed && first) {
    instructions.push(delegateEataPermissionIx(env.owner, balance, env.validator));
  }
  const sent = await sendJournaled(env, {
    id,
    kind: "deposit",
    step: "deposit",
    atoms,
    rollupBefore,
    instructions: withComputeBudget(instructions),
    shape: { kind: "move", atoms, sealed: env.sealed },
    before: wallet,
    moved: atoms,
  });
  return "status" in sent ? sent : null;
}

/** Carries the deposit on from whatever the journal shows: step 1 judged, the rollup balance awaited, then step 2. */
async function carryOn(
  env: TransferEnv,
  id: string,
  atoms: bigint,
  answer: string | undefined,
): Promise<DepositOutcome> {
  const owner = env.owner.toBase58();
  const record = await recordOf(env, id);
  const judged = await reconciled(env, id, record.sends, answer);
  if ("status" in judged) return judged;
  if (!judged.landed) {
    await env.journal.finish(owner, id);
    return refuse(
      "send-failed",
      "The move into the rollup did not land and cannot any more, so nothing moved. Try again.",
    );
  }
  if (record.rollupBefore === undefined) {
    throw new Error(
      `Operation ${id} has no rollup balance on record, so the move cannot be judged`,
    );
  }
  const wallet = walletAccount(env);
  const expected = BigInt(record.rollupBefore) + atoms;
  const shown = await pollUntil(
    async () => {
      const held = await readTokenBalance(env.rollup, wallet);
      return held !== null && held >= expected ? held : null;
    },
    env.clock,
    DELEGATION_SHOWN_WITHIN_MS,
    POLL_MS,
  );
  if (shown === null && !record.seat) {
    return waiting(
      id,
      `The move landed on Solana; the rollup does not yet show ${expected} atoms.`,
    );
  }

  const settled = await settledRollupSend(env, id, record.seat);
  if (settled === "landed") {
    await finishWhenFinalized(env, id);
    return { status: "done", id, atoms, next: "syncView" };
  }
  if (typeof settled === "object" && "failed" in settled) return strandedBy(id, settled.failed);
  if (settled !== "none") return settled;

  const held = await readTokenBalance(env.rollup, wallet);
  if (held === null) return waiting(id, "The rollup does not show the owner's balance yet.");
  const shape = { kind: "seat-deposit", atoms } as const;
  const sent = await signedAndRecordedOnRollup(
    env,
    id,
    [depositInstruction(env, atoms)],
    shape,
    held,
  );
  if ("status" in sent) return sent;
  const result = await sentOnRollup(env, sent);
  if (result.state === "failed") {
    await env.journal.clearSeatSend(owner, id);
    return strandedBy(id, result.error);
  }
  if (result.state === "unconfirmed") {
    return waiting(
      id,
      `The deposit into the seat was sent but its status did not show in time. It is judged from the rollup's status next time; it is never sent again.`,
    );
  }
  await env.journal.markSeatLanded(owner, id);
  await finishWhenFinalized(env, id);
  return { status: "done", id, atoms, next: "syncView" };
}

/** The move into the rollup landed and the deposit was refused: nothing was sent again, and the tokens wait in the owner's rollup balance. */
function strandedBy(id: string, error: string): DepositOutcome {
  const code = errorCode(error);
  const why =
    code === CUSTODY_CAP_REACHED
      ? "The custody cap refused the deposit."
      : code === NO_SEAT
        ? "The wallet has no open account on the exchange."
        : `The deposit was refused: ${error}.`;
  return {
    status: "stranded",
    id,
    message: `${why} The tokens moved into the rollup stay in the owner's balance there: deposit again by hand, or return them to the wallet.`,
  };
}

/**
 * Moves `input.amount` of the owner's quote token from the wallet into the
 * seat: step 1 delegates it into the rollup, step 2 deposits it as collateral.
 * Every send is journaled before it is broadcast, and a run that finds a
 * journal record carries it on without repeating a step that may have landed,
 * asking when it cannot tell. One transfer runs at a time per owner across
 * tabs. When it is done the caller refreshes its view.
 */
export function deposit(env: TransferEnv, input: DepositInput): Promise<DepositOutcome> {
  return underLock(env, async () => {
    let atoms: bigint;
    try {
      atoms = tokenAtoms(input.amount, env.decimals);
    } catch (error) {
      return refuse("invalid-amount", (error as Error).message);
    }
    const stale = await intentRefusal(env, "deposit", input.intent);
    if (stale) return stale;
    const begun = await beginOperation(
      env,
      "deposit",
      atoms,
      input.intent?.kind === "resume" ? input.intent.id : undefined,
    );
    if ("status" in begun) return begun;
    if (!begun.record) {
      const gate = await depositRefusal(env, atoms);
      if ("status" in gate) return gate;
      const refused = await moveIntoRollup(env, begun.id, atoms, gate.wallet);
      if (refused) return refused;
    }
    return carryOn(env, begun.id, atoms, input.answer);
  });
}
