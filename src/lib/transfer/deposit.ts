import "../bufferBigInt";
import { deriveVault } from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  ROUND_TRIP_LAMPORTS,
  POLL_MS,
  beginOperation,
  finishWhenFinalized,
  holdsSol,
  intentRefusal,
  keyDepositInstruction,
  keyHeldInRollup,
  reconciled,
  recordOf,
  refuse,
  sendJournaled,
  sentOnRollup,
  settledRollupSend,
  signedByDepositKey,
  signedWithDepositKey,
  underLock,
  waiting,
  walletAccount,
  withBroadcastError,
  type Intent,
  type Refused,
  type Stopped,
  type TransferEnv,
} from "./operation";
import {
  depositKeyAccount,
  depositKeyBalance,
  fundKeyInstructions,
  moveKeyInstructions,
} from "./depositKey";
import { errorCode, pollUntil, readTokenBalance, type SolanaRpc } from "./solanaRpc";
import { firstDepositNeeds } from "./amount";
import { tokenAtoms } from "./verdicts";

const CUSTODY_CAP_REACHED = 6150;
const ACCOUNT_MISSING = 6114;
const SEAT_TABLE_FULL = 6013;
const SEAT_DEPOSIT_TOO_SMALL = 6156;
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
      /** The move into the rollup landed and the deposit was refused: the tokens sit in the deposit key's rollup balance, from where "Put it in my account" credits them. */
      status: "stranded";
      id: string;
      message: string;
      /** Whether the record stays on the list because the move into the rollup is not final yet; then "Try the deposit again" is the button, else "Put it in my account". */
      recordKept: boolean;
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
 * the account is open, the exchange is not paused, a first deposit meets the
 * exchange's minimum for opening the trading account, and the wallet holds the
 * tokens and the SOL for the steps. The minimum is checked only when it is set
 * and the amount is below it, and then only after the exchange confirms the
 * account holds no seat: a seat given back leaves the view recording it, so a
 * small deposit staged on the strength of that record could be refused after
 * the wallet's funds had moved to the browser key.
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
  if (exchange.minSeatDeposit > 0n && atoms < exchange.minSeatDeposit) {
    const seated = await env.exchange.confirmSeat();
    const { minSeatDeposit } = await env.exchange.read();
    if (!seated && atoms < minSeatDeposit) {
      return refuse(
        "below-seat-minimum",
        `${firstDepositNeeds(minSeatDeposit, env.decimals)}. Nothing was sent.`,
      );
    }
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
 * Step 1, the one signature the wallet gives: a single Solana transaction in
 * which the owner pays `atoms` into the deposit key's token account and the
 * key moves them into the rollup as its own balance (the key co-signs here,
 * locally). The key's rollup balance before it is journaled with the send, so
 * a later run can tell whether it landed.
 */
async function moveToDepositKey(
  env: TransferEnv,
  id: string,
  atoms: bigint,
  wallet: bigint,
): Promise<Refused | { broadcastError: string | null }> {
  const key = env.depositKey.publicKey;
  const first = !(await env.solana.getAccountInfo(depositKeyBalance(key, env.mint), "confirmed"));
  const vaultMissing = !(await env.solana.getAccountInfo(deriveVault(env.mint)[0], "confirmed"));
  const rollupBefore = first ? 0n : await keyHeldInRollup(env);
  if (rollupBefore === null) {
    return refuse(
      "rollup-unreadable",
      "The deposit key's balance is delegated but the rollup does not show it, so the move cannot be checked later. Nothing was sent.",
    );
  }
  const instructions = [
    ...fundKeyInstructions({
      owner: env.owner,
      key,
      mint: env.mint,
      decimals: env.decimals,
      atoms,
    }),
    ...(await moveKeyInstructions({
      owner: env.owner,
      key,
      mint: env.mint,
      validator: env.validator,
      atoms,
      sealed: env.sealed,
      first,
      vaultMissing,
    })),
  ];
  const sent = await sendJournaled(env, {
    id,
    kind: "deposit",
    step: "deposit",
    atoms,
    rollupBefore,
    instructions,
    shape: { kind: "key-move", atoms, sealed: env.sealed, key, decimals: env.decimals },
    cosigner: env.depositKey,
    before: wallet,
    moved: atoms,
  });
  return "status" in sent ? sent : { broadcastError: sent.broadcastError };
}

/**
 * Carries the deposit on from whatever the journal shows: step 1 judged, the
 * deposit key's rollup balance awaited, then step 2, which the key signs and
 * pays for itself, so the wallet is not asked again.
 */
async function carryOn(
  env: TransferEnv,
  id: string,
  atoms: bigint,
  answer: string | undefined,
): Promise<DepositOutcome> {
  const owner = env.owner.toBase58();
  const record = await recordOf(env, id);
  if (record.depositKey === undefined) {
    return refuse(
      "legacy-deposit",
      "This deposit was begun by an earlier version of the app, which put the tokens in your own rollup balance. Return them to your wallet under transfers that need attention, then deposit again. Nothing was sent.",
    );
  }
  if (record.depositKey !== env.depositKey.publicKey.toBase58()) {
    return refuse(
      "deposit-key-missing",
      `The key that finishes this deposit (transfer ${id}) is no longer stored in this browser, so the deposit cannot be finished from here. The USDC has already left your wallet and sits under that key. Do not deposit again. Contact support and give them this transfer id. Nothing new was sent.`,
    );
  }
  const judged = await reconciled(env, id, record.sends, answer);
  if ("status" in judged) return judged;
  if (!judged.landed && record.sends.length > 0) {
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
  const keyRollup = await env.depositRollup();
  const account = depositKeyAccount(env.depositKey.publicKey, env.mint);
  const expected = BigInt(record.rollupBefore) + atoms;
  if (!record.seat) {
    const shown = await pollUntil(
      async () => {
        const held = await readTokenBalance(keyRollup, account);
        return held !== null && held >= expected ? held : null;
      },
      env.clock,
      DELEGATION_SHOWN_WITHIN_MS,
      POLL_MS,
    );
    if (shown === null) {
      return waiting(
        id,
        `The move landed on Solana; the rollup does not yet show ${expected} atoms.`,
      );
    }
  }

  const settled = await settledRollupSend(env, id, record.seat);
  if (settled === "landed") {
    await finishWhenFinalized(env, id);
    return { status: "done", id, atoms, next: "syncView" };
  }
  if (typeof settled === "object" && "failed" in settled) return strand(env, id, settled.failed);
  if (settled !== "none") return settled;

  const held = await readTokenBalance(keyRollup, account);
  if (held === null) return waiting(id, "The rollup does not show the deposit key's balance yet.");
  const shape = { kind: "key-deposit", atoms, key: env.depositKey.publicKey } as const;
  const sent = await signedByDepositKey(env, id, [keyDepositInstruction(env, atoms)], shape, held);
  if ("status" in sent) return sent;
  return sendAndSettle(env, id, atoms, sent, keyRollup);
}

/** Sends the deposit key's recorded deposit into the seat and settles the record by what the rollup shows. */
async function sendAndSettle(
  env: TransferEnv,
  id: string,
  atoms: bigint,
  sent: { raw: Uint8Array; signature: string },
  keyRollup: SolanaRpc,
): Promise<DepositOutcome> {
  const owner = env.owner.toBase58();
  const result = await sentOnRollup(env, sent, keyRollup, id);
  if (result.state === "failed") {
    return strand(env, id, result.error);
  }
  if (result.state === "unconfirmed") {
    return waiting(
      id,
      withBroadcastError(
        `The deposit into the seat was sent but its status did not show in time. It is judged from the rollup's status next time; it is never sent again.`,
        result.broadcastError,
      ),
    );
  }
  await env.journal.markSeatLanded(owner, id);
  await finishWhenFinalized(env, id);
  return { status: "done", id, atoms, next: "syncView" };
}

/**
 * Closes out a deposit the program refused. The refusal is final (the seat
 * send failed at finalized) and the tokens wait in the deposit key's rollup
 * balance, which "Put it in my account" credits, so the record is marked
 * stranded and finished as soon as every send of it is final, and no later than
 * the next look. While the move into the rollup is only confirmed its record
 * stays, with its signature and expiry, so a new deposit cannot start before
 * that move has settled; "Try the deposit again" credits the key's balance from
 * that state.
 */
async function strand(env: TransferEnv, id: string, error: string): Promise<DepositOutcome> {
  const owner = env.owner.toBase58();
  await env.journal.clearSeatSend(owner, id);
  await env.journal.markStranded(owner, id);
  return strandedBy(id, error, !(await finishWhenFinalized(env, id)));
}

/** The move into the rollup landed and the deposit was refused: nothing was sent again, and the tokens wait in the deposit key's rollup balance. */
function strandedBy(id: string, error: string, recordKept: boolean): DepositOutcome {
  const code = errorCode(error);
  const why =
    code === CUSTODY_CAP_REACHED
      ? "The exchange is at its deposit limit right now."
      : code === ACCOUNT_MISSING
        ? "Your wallet has no open account on the exchange."
        : code === SEAT_TABLE_FULL
          ? "New trading accounts are full right now. Try again later."
          : code === SEAT_DEPOSIT_TOO_SMALL
            ? "Your first deposit was too small to open your trading account."
            : "The exchange did not accept the last step.";
  return {
    status: "stranded",
    id,
    recordKept,
    message: `${why} Your USDC left your wallet and is safe: it is held by this browser's deposit key. You do not need to send more.`,
  };
}

/**
 * Moves `input.amount` of the owner's quote token from the wallet into the
 * seat: step 1 (the wallet's only signature, a Solana transaction) moves it
 * into the rollup as the deposit key's balance, step 2 (signed by the key)
 * deposits it as collateral for the owner.
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
    if (!begun.record && input.intent?.kind === "resume") {
      return refuse(
        "record-changed",
        "This transfer sent nothing and is gone, so it is not carried on. Nothing was sent.",
      );
    }
    let broadcastError: string | null = null;
    if (!begun.record) {
      const gate = await depositRefusal(env, atoms);
      if ("status" in gate) return gate;
      const moved = await moveToDepositKey(env, begun.id, atoms, gate.wallet);
      if ("status" in moved) return moved;
      broadcastError = moved.broadcastError;
    }
    const outcome = await carryOn(env, begun.id, atoms, input.answer);
    return outcome.status === "waiting" || outcome.status === "unknown"
      ? { ...outcome, message: withBroadcastError(outcome.message, broadcastError) }
      : outcome;
  });
}

/**
 * Puts into the account whatever the deposit key still holds in the rollup
 * when no transfer is open: the way back for tokens left there by a deposit
 * whose record is gone. The whole balance is credited in one deposit signed
 * by the key and journaled with its record before it is sent, so an
 * interrupted run is carried on like any deposit and never sent twice.
 */
export function recoverDepositKey(env: TransferEnv): Promise<DepositOutcome> {
  return underLock(env, async () => {
    const owner = env.owner.toBase58();
    if ((await env.journal.unfinished(owner)).length > 0) {
      return refuse(
        "unfinished-operation",
        "Another transfer is not finished yet. Finish it first. Nothing was sent.",
      );
    }
    if (!(await env.exchange.accountOpen())) {
      return refuse(
        "account-not-open",
        "This wallet has no open account on the exchange. Nothing was sent.",
      );
    }
    const keyRollup = await env.depositRollup();
    const held = await readTokenBalance(
      keyRollup,
      depositKeyAccount(env.depositKey.publicKey, env.mint),
    );
    if (held === null) {
      return refuse(
        "rollup-unreadable",
        "The rollup does not show the deposit key's balance. Nothing was sent.",
      );
    }
    if (held === 0n) {
      return refuse("nothing-to-recover", "The deposit key holds nothing in the rollup.");
    }
    const shape = { kind: "key-deposit", atoms: held, key: env.depositKey.publicKey } as const;
    const signed = await signedWithDepositKey(env, [keyDepositInstruction(env, held)], shape, held);
    if ("status" in signed) return signed;
    const id = env.newId();
    await env.journal.record(owner, {
      id,
      kind: "deposit",
      atoms: held.toString(),
      step: "deposit",
      rollupBefore: "0",
      depositKey: env.depositKey.publicKey.toBase58(),
      seat: signed.seat,
      sends: [],
    });
    return sendAndSettle(env, id, held, signed, keyRollup);
  });
}
