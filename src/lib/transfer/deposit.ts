import "../bufferBigInt";
import { deriveVault } from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  ROUND_TRIP_LAMPORTS,
  POLL_MS,
  beginOperation,
  custodyAccount,
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
  type Intent,
  type Refused,
  type Stopped,
  type TransferEnv,
} from "./operation";
import { withComputeBudget } from "./computeBudget";
import {
  depositKeyAccount,
  depositKeyBalance,
  fundKeyInstructions,
  moveKeyInstructions,
} from "./depositKey";
import { errorCode, pollUntil, readTokenBalance, type SolanaRpc } from "./solanaRpc";
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
      /** The move into the rollup landed and the deposit was refused: the tokens sit in the deposit key's rollup balance. Retry the deposit. */
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
): Promise<Refused | null> {
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
    instructions: withComputeBudget(instructions),
    shape: { kind: "key-move", atoms, sealed: env.sealed, key, decimals: env.decimals },
    cosigner: env.depositKey,
    before: wallet,
    moved: atoms,
  });
  return "status" in sent ? sent : null;
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
      "This deposit was made with a deposit key this browser no longer holds, so it cannot be finished from here. Nothing was sent.",
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
  const shown = await pollUntil(
    async () => {
      const held = await readTokenBalance(keyRollup, account);
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
  const result = await sentOnRollup(env, sent, keyRollup);
  if (result.state === "failed") {
    return strand(env, id, result.error);
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

/**
 * Closes out a deposit the program refused. The seat send is cleared so the
 * deposit can be tried again; a recovery, which has no Solana send to keep,
 * is finished instead, since it is made again from what the key holds.
 */
async function strand(env: TransferEnv, id: string, error: string): Promise<DepositOutcome> {
  const owner = env.owner.toBase58();
  const record = (await env.journal.unfinished(owner)).find((candidate) => candidate.id === id);
  if (record && record.sends.length === 0) await env.journal.finish(owner, id);
  else await env.journal.clearSeatSend(owner, id);
  return strandedBy(id, error);
}

/** The move into the rollup landed and the deposit was refused: nothing was sent again, and the tokens wait in the deposit key's rollup balance. */
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
    message: `${why} The tokens moved into the rollup stay safe in this browser's deposit key there: deposit again by hand to put them in your account.`,
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
    if (!begun.record) {
      const gate = await depositRefusal(env, atoms);
      if ("status" in gate) return gate;
      const refused = await moveToDepositKey(env, begun.id, atoms, gate.wallet);
      if (refused) return refused;
    }
    return carryOn(env, begun.id, atoms, input.answer);
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
