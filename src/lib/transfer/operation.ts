import {
  DelegationStatus,
  deriveEphemeralAta,
  delegationRecordPdaFromDelegatedAccount,
  parseDelegationRecordAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { Transaction } from "@solana/web3.js";
import { programAddresses, programInstructions, type CustodyToken } from "../rollup/sdk";
import { toSolanaSend, type Journal, type JournalSend, type OperationRecord } from "./journal";
import { signableRefusal, validatedPins, type TransferPins, type TransferShape } from "./guard";
import { associatedTokenAddress, createAssociatedTokenAccountIdempotentIx } from "./tokenAccounts";
import type { OwnerLock } from "./lock";
import { judgeSend, recordThenBroadcast, signatureOf } from "./send";
import {
  confirmSignature,
  freshBlockhash,
  readTokenBalance,
  simulationError,
  type Clock,
  type SolanaRpc,
} from "./solanaRpc";
import { exitOperation, type ExitOperation, type SeatSend, type SolanaVerdict } from "./verdicts";

/** What the exit's steps on Solana cost their fee payer, in lamports: the transaction fee and the rent of the accounts the token program makes. */
export const SOLANA_EXIT_LAMPORTS = 10_000_000;
/** What a deposit's two steps cost their fee payer: the move into the rollup also pays the balance account's rent and the mint's escrow account, so three times the exit's. */
export const ROUND_TRIP_LAMPORTS = 30_000_000;

export const SOLANA_ARRIVES_WITHIN_MS = 180_000;
export const SHOWN_IN_ROLLUP_WITHIN_MS = 30_000;
export const ROLLUP_CONFIRMS_WITHIN_MS = 60_000;
export const POLL_MS = 1_000;

/** The exchange as the transfers see it; the app builds it from the program client so this module never imports it. */
export interface ExchangePort {
  /** Whether the owner has an open account (seat) on the exchange. */
  accountOpen(): Promise<boolean>;
  read(): Promise<{ paused: boolean; custodyCap: bigint }>;
  /** The collateral token as the exchange registered it; its mint must be the pinned one. */
  token: CustodyToken;
  /** Every perp market the exchange has, in rising order, which a withdrawal names. */
  perpMarketIds(): Promise<number[]>;
}

export interface TransferEnv {
  owner: PublicKey;
  /** The app's pins, validated; `mint` and `validator` are the pinned ones. */
  pins: TransferPins;
  mint: PublicKey;
  validator: PublicKey;
  decimals: number;
  /** Whether the custody is sealed, which takes a private balance. */
  sealed: boolean;
  solana: SolanaRpc;
  /** The rollup endpoint, able to read the owner's token account (a private endpoint is signed in as the owner). */
  rollup: SolanaRpc;
  exchange: ExchangePort;
  journal: Journal;
  lock(owner: string): Promise<OwnerLock | null>;
  /** The only way the owner signs: the transaction must be exactly the one `shape` names before the app's own checks run. */
  signChecked(transaction: Transaction, shape: TransferShape): Promise<Transaction>;
  clock: Clock;
  newId(): string;
}

/**
 * The one way to make an env: the pins are validated against the registered
 * token, and every transaction is compared with the exact one the flow means to
 * send just before `signChecked` is asked to sign it.
 */
export function createTransferEnv(
  parts: Omit<TransferEnv, "pins" | "mint" | "validator" | "signChecked"> & {
    pins: TransferPins;
    signChecked(transaction: Transaction): Promise<Transaction>;
  },
): TransferEnv {
  const pins = validatedPins(parts.pins);
  if (!parts.exchange.token.mint.equals(pins.mint)) {
    throw new Error("The exchange's collateral token is not the pinned mint");
  }
  return {
    ...parts,
    pins,
    mint: pins.mint,
    validator: pins.validator,
    signChecked: async (transaction, shape) => {
      const why = await signableRefusal(
        { pins, owner: parts.owner, token: parts.exchange.token },
        transaction,
        shape,
      );
      if (why) throw new Error(`Refusing to sign: ${why}`);
      return parts.signChecked(transaction);
    },
  };
}

const shapeRefusal = (env: TransferEnv, transaction: Transaction, shape: TransferShape) =>
  signableRefusal(
    { pins: env.pins, owner: env.owner, token: env.exchange.token },
    transaction,
    shape,
  );

export type Refusal =
  | "transaction-not-allowed"
  | "invalid-amount"
  | "unfinished-operation"
  | "account-not-open"
  | "exchange-paused"
  | "custody-unreadable"
  | "custody-cap"
  | "insufficient-usdc"
  | "insufficient-sol"
  | "above-free-collateral"
  | "sealed-balance-missing"
  | "delegated-elsewhere"
  | "simulation-failed"
  | "stale-price"
  | "rollup-refused"
  | "rollup-unreadable"
  | "send-failed"
  | "nothing-to-return"
  | "deposit-landed"
  | "rollup-short"
  | "nothing-to-dismiss"
  | "not-dismissable"
  | "record-changed";

export interface Refused {
  status: "refused";
  reason: Refusal;
  message: string;
}

/** Why a transfer stopped without finishing or moving anything new: another tab holds the lock, a refusal, a send that may still land, or one that cannot be told. */
export type Stopped =
  | { status: "busy" }
  | Refused
  | { status: "waiting"; id: string; message: string }
  | {
      /** A rollup send past its blockhash expiry that the rollup never showed. It is kept on record until dismissed, and dismissing never resends it. */
      status: "not-landed";
      id: string;
      signature: string;
      message: string;
    }
  | {
      status: "unknown";
      id: string;
      subject: "solana-send" | "rollup-send";
      message: string;
      /** The signature to look the send up by. */
      signature?: string;
      /** The answers the operator may give after looking, passed back as `answer`. */
      answers: string[];
    };

export const refuse = (reason: Refusal, message: string): Refused => ({
  status: "refused",
  reason,
  message,
});

const notAllowed = (why: string) =>
  refuse(
    "transaction-not-allowed",
    `The transaction is not one this app signs (${why}). Nothing was sent.`,
  );

export const waiting = (id: string, message: string): Stopped => ({
  status: "waiting",
  id,
  message,
});

export { associatedTokenAddress, createAssociatedTokenAccountIdempotentIx };

export const walletAccount = (env: TransferEnv) => associatedTokenAddress(env.owner, env.mint);
export const balanceAccount = (env: TransferEnv) => deriveEphemeralAta(env.owner, env.mint)[0];

/** The custody token account that deposits land in, derived from the pinned program and the registered token. */
export const custodyAccount = (env: TransferEnv) =>
  programAddresses(env.pins.programId).custody(env.exchange.token);

/** The order book's collateral deposit of the owner's own tokens in the rollup. */
export const depositInstruction = (env: TransferEnv, atoms: bigint) =>
  programInstructions(env.pins.programId).deposit(
    env.owner,
    walletAccount(env),
    env.exchange.token,
    env.owner,
    { collateral: true },
    atoms,
  );

/** The order book's collateral withdrawal into the owner's token account in the rollup. */
export const withdrawInstruction = (env: TransferEnv, atoms: bigint, marketIds: number[]) =>
  programInstructions(env.pins.programId).withdraw(
    env.owner,
    walletAccount(env),
    env.exchange.token,
    { collateral: true },
    atoms,
    marketIds,
  );

/** Where the owner's balance account is delegated on Solana: the validator, or null when it is not delegated. */
export async function delegatedTo(env: TransferEnv): Promise<PublicKey | null> {
  const record = parseDelegationRecordAccount(
    await env.solana.getAccountInfo(
      delegationRecordPdaFromDelegatedAccount(balanceAccount(env)),
      "confirmed",
    ),
  );
  return record.status === DelegationStatus.Delegated ? record.validator : null;
}

/**
 * What the owner holds in the rollup: the token account's amount there while
 * the balance is delegated, 0 when it is not, and null when it is delegated
 * but the rollup does not show it. A rollup serves the token account it clones
 * from Solana when nothing is delegated, which is not held in the rollup.
 */
export async function heldInRollup(env: TransferEnv): Promise<bigint | null> {
  if (!(await delegatedTo(env))) return 0n;
  return readTokenBalance(env.rollup, walletAccount(env));
}

/** Runs `run` while holding the owner's lock, which another tab of this browser holding gives `busy`. */
export async function underLock<T>(env: TransferEnv, run: () => Promise<T>): Promise<T | Stopped> {
  const lock = await env.lock(env.owner.toBase58());
  if (!lock) return { status: "busy" };
  try {
    return await run();
  } finally {
    lock.release();
  }
}

export const asExitOperation = (owner: string, record: OperationRecord): ExitOperation => ({
  id: record.id,
  owner,
  atoms: record.atoms,
  method: record.step,
  seat: record.seat,
  solana: record.sends.map(toSolanaSend),
});

/** The unfinished operation to carry on: a return to the wallet first, else the oldest. */
export function currentRecord(records: OperationRecord[]): OperationRecord | null {
  const sorted = [...records].sort(
    (a, b) =>
      Number(b.step === "return") - Number(a.step === "return") || a.createdAt - b.createdAt,
  );
  return sorted[0] ?? null;
}

/**
 * What the caller meant when it started a flow: a new transfer, or carrying on
 * the one record it showed. Checked inside the owner's lock against the
 * journal as it is now, so a screen that went stale in another tab can never
 * turn into a transfer the user did not ask for.
 */
export type Intent = { kind: "new" } | { kind: "resume"; id: string; atoms: string };

/**
 * Refuses, sending nothing, when the journal no longer matches `intent`: a
 * new transfer finds a record that appeared, a resume finds its record gone,
 * of another kind or amount, or no longer the one to carry on. Without an
 * intent nothing is checked.
 */
export async function intentRefusal(
  env: TransferEnv,
  method: "deposit" | "withdraw",
  intent: Intent | undefined,
): Promise<Refused | null> {
  if (!intent) return null;
  const records = await env.journal.unfinished(env.owner.toBase58());
  if (intent.kind === "new") {
    return records.length === 0
      ? null
      : refuse(
          "unfinished-operation",
          "Another transfer is open now, perhaps from another tab. Finish it first. Nothing was sent.",
        );
  }
  const record = records.find((candidate) => candidate.id === intent.id);
  if (!record) {
    return refuse(
      "record-changed",
      "This transfer already finished, perhaps in another tab. Nothing was sent.",
    );
  }
  if (
    record.kind !== method ||
    record.atoms !== intent.atoms ||
    currentRecord(records)?.id !== record.id
  ) {
    return refuse("record-changed", "This transfer changed since it was shown. Nothing was sent.");
  }
  return null;
}

/**
 * The operation to carry on for `method` and `atoms`: the unfinished one when
 * it asked for the same, else a new id; a refusal when an unfinished one asked
 * for something else, since carrying on with different figures would hide what
 * the first sent. A leftover that sent nothing is dropped.
 */
export async function beginOperation(
  env: TransferEnv,
  method: "deposit" | "withdraw",
  atoms: bigint,
): Promise<{ id: string; record: OperationRecord | null } | Refused> {
  const owner = env.owner.toBase58();
  for (const done of await env.journal.unfinished(owner)) {
    if (done.step === "deposit" && done.seat?.state === "landed") {
      await finishWhenFinalized(env, done.id);
    }
  }
  const current = currentRecord(await env.journal.unfinished(owner));
  let operation: ExitOperation;
  try {
    operation = exitOperation(current ? asExitOperation(owner, current) : null, {
      id: env.newId(),
      owner,
      atoms,
      method,
    });
  } catch (error) {
    return refuse("unfinished-operation", (error as Error).message);
  }
  if (current && operation.id !== current.id) await env.journal.finish(owner, current.id);
  return { id: operation.id, record: current && operation.id === current.id ? current : null };
}

export async function recordOf(env: TransferEnv, id: string): Promise<OperationRecord> {
  const found = (await env.journal.unfinished(env.owner.toBase58())).find((r) => r.id === id);
  if (!found) throw new Error(`Operation ${id} is not on record`);
  return found;
}

/** Whether the owner holds at least `lamports` of SOL on Solana, the fee payer's cost of the steps there. */
export async function holdsSol(env: TransferEnv, lamports: number): Promise<Refused | null> {
  const held = await env.solana.getBalance(env.owner, "confirmed");
  return held >= lamports
    ? null
    : refuse(
        "insufficient-sol",
        `The wallet holds ${held} lamports of SOL, and the steps on Solana need about ${lamports} for fees and rent. Nothing was sent.`,
      );
}

/**
 * Signs and sends one transaction on Solana, written to the journal after it
 * is signed and before it is broadcast, and waits for it. A broadcast that
 * fails is not a verdict: the journal holds the send and the next read judges
 * it. Simulated first, so a refusal sends nothing.
 */
export async function sendJournaled(
  env: TransferEnv,
  plan: {
    id: string;
    kind: "deposit" | "withdraw";
    step: string;
    atoms: bigint;
    rollupBefore?: bigint;
    instructions: TransactionInstruction[];
    /** The exact transaction these instructions must make. */
    shape: TransferShape;
    /** The owner's token account on Solana before this send, and what it is to move. */
    before: bigint;
    moved: bigint;
  },
): Promise<Refused | { signature: string }> {
  const { blockhash, lastValidBlockHeight } = await freshBlockhash(env.solana);
  const transaction = new Transaction({
    feePayer: env.owner,
    blockhash,
    lastValidBlockHeight,
  }).add(...plan.instructions);
  const unsafe = await shapeRefusal(env, transaction, plan.shape);
  if (unsafe) return notAllowed(unsafe);
  let failure: string | null;
  try {
    failure = await simulationError(env.solana, transaction);
  } catch (error) {
    return refuse(
      "simulation-failed",
      `Solana would not simulate the transaction (${(error as Error).message.split("\n")[0]}), so it is not sent. Nothing was sent.`,
    );
  }
  if (failure !== null) {
    return refuse(
      "simulation-failed",
      `Solana would refuse the transaction with ${failure}. Nothing was sent.`,
    );
  }
  const raw = (await env.signChecked(transaction, plan.shape)).serialize();
  const owner = env.owner.toBase58();
  const { signature } = await recordThenBroadcast({
    journal: env.journal,
    owner,
    op: {
      id: plan.id,
      kind: plan.kind,
      atoms: plan.atoms.toString(),
      step: plan.step,
      rollupBefore: plan.rollupBefore?.toString(),
    },
    lastValidBlockHeight,
    before: plan.before.toString(),
    moved: plan.moved.toString(),
    signedTx: raw,
    broadcast: (signed) =>
      env.solana.sendRawTransaction(signed, { preflightCommitment: "confirmed" }).catch(() => null),
  });
  const result = await confirmSignature(env.solana, signature, {
    clock: env.clock,
    timeoutMs: SOLANA_ARRIVES_WITHIN_MS,
    lastValidBlockHeight,
    rebroadcast: raw,
  });
  if (result.seen) await env.journal.markSeen(owner, plan.id, signature, result.seen);
  return { signature };
}

/**
 * Judges each send an earlier run wrote down before another is built: a send
 * that landed is returned, one that failed or can never land is dropped, and
 * one that may still land stops the run (asking, when it was seen as
 * processed and only the operator's word can release it).
 */
export async function reconciled(
  env: TransferEnv,
  id: string,
  sends: JournalSend[],
  answer: string | undefined,
): Promise<{ landed: JournalSend | null } | Stopped> {
  const owner = env.owner.toBase58();
  let landed: JournalSend | null = null;
  for (const send of sends) {
    const verdict: SolanaVerdict = await judgeSend({
      journal: env.journal,
      owner,
      id,
      connection: env.solana,
      send,
      answer,
    });
    if (verdict === "landed") landed = send;
    if (verdict === "wait") {
      const seen = send.status !== undefined;
      return seen
        ? {
            status: "unknown",
            id,
            subject: "solana-send",
            message: `The transaction ${send.signature} was seen as processed, not confirmed, so it may still confirm even once its blockhash has expired. Look at the signature and the balances; nothing more is sent until it is answered.`,
            answers: [`landed:${send.signature}`],
          }
        : waiting(
            id,
            `The transaction ${send.signature} is not on Solana yet and can still land until block height ${send.lastValidBlockHeight}. Nothing more is sent until that has passed.`,
          );
    }
  }
  return { landed };
}

/**
 * Signs a rollup transaction and writes it to the journal, with its signature
 * and the last block height of its blockhash, before anything is sent. The
 * caller sends it only after this resolves. `before` is the owner's rollup
 * balance now, which a later read judges the send against.
 */
export async function signedAndRecordedOnRollup(
  env: TransferEnv,
  id: string,
  instructions: TransactionInstruction[],
  shape: TransferShape,
  before: bigint,
): Promise<Refused | { raw: Uint8Array; signature: string; seatId: string }> {
  const { blockhash, lastValidBlockHeight } = await freshBlockhash(env.rollup);
  const transaction = new Transaction({ feePayer: env.owner, blockhash, lastValidBlockHeight }).add(
    ...instructions,
  );
  const unsafe = await shapeRefusal(env, transaction, shape);
  if (unsafe) return notAllowed(unsafe);
  const raw = (await env.signChecked(transaction, shape)).serialize();
  const signature = signatureOf(raw);
  const seatId = env.newId();
  await env.journal.recordSeatSend(env.owner.toBase58(), id, {
    state: "pending",
    at: new Date(env.clock.now()).toISOString(),
    id: seatId,
    before: before.toString(),
    signature,
    lastValidBlockHeight,
  });
  return { raw, signature, seatId };
}

export type RollupSendState =
  /** Its status shows success; `finalized` is whether that can no longer be undone. */
  | { kind: "landed"; finalized: boolean }
  /** Its status shows an error at finalized commitment, so it moved nothing and cannot be replayed. */
  | { kind: "failed"; error: string }
  | { kind: "pending" }
  /** Past its blockhash's last valid height and the status was read successfully as absent. */
  | { kind: "not-seen" }
  /** The status could not be read, or the send was not written down with its signature. Never taken as absent. */
  | { kind: "unknown" };

/**
 * Where a recorded rollup send stands, from its signature's status alone: a
 * success is `landed` (final once finalized), an error is `failed` only once
 * finalized (a confirmed error may still be rolled back, so it waits), no
 * status within its blockhash's life is `pending`, and none past it, read
 * successfully, is `not-seen`. A balance never decides: trading can move it by
 * the same amount. A status read that fails is `unknown`, never absent.
 */
export async function rollupSendState(env: TransferEnv, seat: SeatSend): Promise<RollupSendState> {
  const recordedLanded = seat.state === "landed";
  if (!seat.signature || seat.lastValidBlockHeight === undefined) {
    return recordedLanded ? { kind: "landed", finalized: false } : { kind: "unknown" };
  }
  try {
    const { value } = await env.rollup.getSignatureStatus(seat.signature, {
      searchTransactionHistory: true,
    });
    if (value) {
      if (value.confirmationStatus === "processed") {
        return recordedLanded ? { kind: "landed", finalized: false } : { kind: "pending" };
      }
      if (value.err) {
        return value.confirmationStatus === "finalized"
          ? { kind: "failed", error: JSON.stringify(value.err) }
          : { kind: "pending" };
      }
      return { kind: "landed", finalized: value.confirmationStatus === "finalized" };
    }
    if (recordedLanded) return { kind: "landed", finalized: false };
    const height = await env.rollup.getBlockHeight("confirmed");
    return height > seat.lastValidBlockHeight ? { kind: "not-seen" } : { kind: "pending" };
  } catch {
    return recordedLanded ? { kind: "landed", finalized: false } : { kind: "unknown" };
  }
}

/**
 * Whether every send of the operation has settled for good: the rollup send, if
 * any, is finalized, and each Solana send is finalized, shown finally failed,
 * or past its blockhash's life and absent. Anything short of that may still be
 * rolled back or land, so the record must stay. A read that fails is not final.
 */
export async function operationFinal(env: TransferEnv, record: OperationRecord): Promise<boolean> {
  if (record.seat) {
    const state = await rollupSendState(env, record.seat);
    if (state.kind !== "landed" || !state.finalized) return false;
  }
  try {
    for (const send of record.sends) {
      const { value } = await env.solana.getSignatureStatus(send.signature, {
        searchTransactionHistory: true,
      });
      if (value) {
        if (value.confirmationStatus !== "finalized") return false;
      } else if ((await env.solana.getBlockHeight("confirmed")) <= send.lastValidBlockHeight) {
        return false;
      } else if (send.status !== undefined) {
        return false;
      }
    }
  } catch {
    return false;
  }
  return true;
}

/** Closes a finished operation's record once every send of it is final, and not before. */
export async function finishWhenFinalized(env: TransferEnv, id: string): Promise<boolean> {
  const owner = env.owner.toBase58();
  const record = (await env.journal.unfinished(owner)).find((candidate) => candidate.id === id);
  if (!record) return true;
  if (!(await operationFinal(env, record))) return false;
  await env.journal.finish(owner, id);
  return true;
}

/**
 * Settles a recorded rollup send before anything else is done about it. Never
 * resends: `none` when there is no send on record, `landed` once its status
 * shows success (the record is marked), `failed` once its status shows an error
 * (finalized, so it cannot be replayed; the record is cleared, and a new
 * operation is the user's to start), and otherwise the stop to show.
 */
export async function settledRollupSend(
  env: TransferEnv,
  id: string,
  seat: SeatSend | undefined,
  requireFinal = false,
): Promise<"none" | "landed" | { failed: string } | Stopped> {
  if (!seat) return "none";
  const owner = env.owner.toBase58();
  const state = await rollupSendState(env, seat);
  if (state.kind === "landed") {
    if (seat.state === "pending") await env.journal.markSeatLanded(owner, id);
    if (requireFinal && !state.finalized) {
      return waiting(
        id,
        `The rollup transaction ${seat.signature} is confirmed but not yet finalized. The next step starts only once it is, and nothing is sent again.`,
      );
    }
    return "landed";
  }
  if (state.kind === "failed") {
    await env.journal.clearSeatSend(owner, id);
    return { failed: state.error };
  }
  if (state.kind === "pending") {
    return waiting(
      id,
      `The rollup transaction ${seat.signature} may still land until the rollup passes block height ${seat.lastValidBlockHeight}. Nothing is sent again.`,
    );
  }
  if (state.kind === "not-seen") {
    return {
      status: "not-landed",
      id,
      signature: seat.signature ?? "",
      message: `The rollup transaction ${seat.signature} did not go through: it was never shown and its blockhash has expired. It stays on record until it is dismissed, and dismissing it sends nothing. If it is later shown to have landed, the balances will say so.`,
    };
  }
  return {
    status: "unknown",
    id,
    subject: "rollup-send",
    signature: seat.signature,
    message: `A rollup transaction${seat.signature ? ` ${seat.signature}` : ""} cannot be placed${seat.signature ? ": its status could not be read" : ": it was not written down with its signature"}. It cannot be dismissed. It is looked at again next time; wait, or contact support with the signature. Nothing is sent again.`,
    answers: [],
  };
}

/**
 * Sends a signed rollup transaction and waits for its status: confirmed, shown
 * failed (the rollup ran it and refused, so it moved nothing), or unconfirmed
 * (it may still land, so only a balance can tell).
 */
export async function sentOnRollup(
  env: TransferEnv,
  sent: { raw: Uint8Array; signature: string },
): Promise<{ state: "confirmed" } | { state: "failed"; error: string } | { state: "unconfirmed" }> {
  await env.rollup.sendRawTransaction(sent.raw, { skipPreflight: true }).catch(() => null);
  const result = await confirmSignature(env.rollup, sent.signature, {
    clock: env.clock,
    timeoutMs: ROLLUP_CONFIRMS_WITHIN_MS,
  });
  if (result.state === "confirmed") return { state: "confirmed" };
  if (result.state === "failed" && result.seen === "finalized") {
    return { state: "failed", error: result.error };
  }
  return { state: "unconfirmed" };
}
