import "../bufferBigInt";
import {
  DelegationStatus,
  deriveEphemeralAta,
  delegationRecordPdaFromDelegatedAccount,
  parseDelegationRecordAccount,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import type { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { PACKET_DATA_SIZE, Transaction } from "@solana/web3.js";
import type { KeyWithdrawal } from "../trading/types";
import type { MainnetChain } from "../wallet/ownerSigner";
import { depositKeyAccount, depositKeyBalance } from "./depositKey";
import { redactToken } from "../rollup/redact";
import { programInstructions, type CustodyToken } from "../rollup/sdk";
export { ROUND_TRIP_LAMPORTS, SOLANA_EXIT_LAMPORTS } from "./computeBudget";
import {
  isKeySweep,
  toSolanaSend,
  type Journal,
  type JournalSend,
  type OperationRecord,
  type SendLeg,
} from "./journal";
import { signableRefusal, validatedPins, type TransferPins, type TransferShape } from "./guard";
import { associatedTokenAddress, createAssociatedTokenAccountIdempotentIx } from "./tokenAccounts";
import type { OwnerLock } from "./lock";
import { judgeSend, recordThenBroadcast, signatureOf } from "./send";
import { MISSING_RECHECK_MS } from "./verdicts";
import {
  computeUnitsAfterSimulation,
  microLamportsFromFees,
  withComputeBudget,
} from "./computeBudget";
import {
  confirmSignature,
  freshBlockhash,
  readTokenBalance,
  recentPrioritizationFees,
  simulation,
  type Clock,
  type SolanaRpc,
} from "./solanaRpc";
import { exitOperation, type ExitOperation, type SeatSend, type SolanaVerdict } from "./verdicts";

/** What to say about a withdrawal an order key sent whose outcome was not proven. It is never sent again. */
export const ORDER_KEY_WITHDRAWAL_UNPROVEN =
  "We cannot tell whether this withdrawal went through. Check your wallet's token account in the rollup before trying again. Nothing is sent again.";

export const SOLANA_ARRIVES_WITHIN_MS = 180_000;
export const SHOWN_IN_ROLLUP_WITHIN_MS = 30_000;
export const ROLLUP_CONFIRMS_WITHIN_MS = 60_000;
export const POLL_MS = 1_000;

/** The exchange as the transfers see it; the app builds it from the program client so this module never imports it. */
export interface ExchangePort {
  /** Whether the owner has an open account (a view) on the exchange. It may hold no seat yet: the first deposit takes one. */
  accountOpen(): Promise<boolean>;
  /** Whether the account holds a seat right now, confirmed with the exchange and not read from the last view, which a released seat leaves unchanged. */
  confirmSeat(): Promise<boolean>;
  /** `minSeatDeposit` is the collateral a first deposit must bring to take a seat; 0 for no minimum. */
  read(): Promise<{ paused: boolean; minSeatDeposit: bigint }>;
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
  /** The owner's deposit key, kept in this browser: it holds the deposited tokens in the rollup and credits them to the account, so the wallet signs nothing in the rollup. Made and stored before any wallet prompt. */
  depositKey: Keypair;
  /** The rollup endpoint signed in as the deposit key, which alone can read the key's token account. Signs in on first use, with no wallet. */
  depositRollup(): Promise<SolanaRpc>;
  exchange: ExchangePort;
  /**
   * Present only where the deployment takes the owner's consent as a signed
   * message: the seat's withdrawal is then signed by an order key through the
   * trading client, and the wallet signs no rollup transaction at all.
   */
  withdrawByKey?(
    atoms: bigint,
    /** Called with the order key's signed bytes before they are dispatched; the call must send nothing if it fails. */
    onSigned?: (raw: Uint8Array) => Promise<void>,
  ): Promise<KeyWithdrawal>;
  journal: Journal;
  lock(owner: string): Promise<OwnerLock | null>;
  /** The only way the owner signs: the transaction must be exactly the one `shape` names before the app's own checks run. `chain` is "solana:mainnet" for a send to Solana, and absent for a rollup send. */
  signChecked(
    transaction: Transaction,
    shape: TransferShape,
    chain?: MainnetChain,
  ): Promise<Transaction>;
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
    signChecked(transaction: Transaction, chain?: MainnetChain): Promise<Transaction>;
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
    signChecked: async (transaction, shape, chain) => {
      if (!chain && parts.withdrawByKey) {
        throw new Error(
          "Refusing to sign: this deployment takes no wallet-signed rollup transaction",
        );
      }
      const why = await signableRefusal(
        { pins, owner: parts.owner, token: parts.exchange.token },
        transaction,
        shape,
      );
      if (why) throw new Error(`Refusing to sign: ${why}`);
      return parts.signChecked(transaction, chain);
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
  | "below-seat-minimum"
  | "insufficient-usdc"
  | "insufficient-sol"
  | "above-free-collateral"
  | "nothing-in-account"
  | "sealed-balance-missing"
  | "delegated-elsewhere"
  | "simulation-failed"
  | "simulation-unavailable"
  | "stale-price"
  | "rollup-refused"
  | "rollup-unreadable"
  | "send-failed"
  | "nothing-to-return"
  | "nothing-to-recover"
  | "legacy-deposit"
  | "deposit-key-missing"
  | "deposit-landed"
  | "key-moved"
  | "key-empty"
  | "rollup-short"
  | "nothing-to-dismiss"
  | "not-dismissable"
  | "record-changed";

export interface Refused {
  status: "refused";
  reason: Refusal;
  message: string;
  /** Set when the collateral already left the account and the stop was in the step that takes it to the wallet, so the USDC is in the rollup balance and not where it started. */
  inRollup?: true;
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

/** The refusal for a deposit whose key is no longer the one stored in this browser. */
export const depositKeyMissing = (id: string) =>
  refuse(
    "deposit-key-missing",
    `The key that finishes this deposit (transfer ${id}) is no longer stored in this browser, so the deposit cannot be finished from here. The USDC has already left your wallet and sits under that key. Do not deposit again. Contact support and give them this transfer id. Nothing new was sent.`,
  );

export { associatedTokenAddress, createAssociatedTokenAccountIdempotentIx };

export const walletAccount = (env: TransferEnv) => associatedTokenAddress(env.owner, env.mint);
export const balanceAccount = (env: TransferEnv) => deriveEphemeralAta(env.owner, env.mint)[0];

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

/** The order book's collateral deposit out of the deposit key's balance in the rollup, crediting the owner's account; the key signs it and pays for it. */
export const keyDepositInstruction = (env: TransferEnv, atoms: bigint) =>
  programInstructions(env.pins.programId).deposit(
    env.depositKey.publicKey,
    depositKeyAccount(env.depositKey.publicKey, env.mint),
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
export async function delegatedTo(
  env: TransferEnv,
  balance: PublicKey = balanceAccount(env),
): Promise<PublicKey | null> {
  const record = parseDelegationRecordAccount(
    await env.solana.getAccountInfo(delegationRecordPdaFromDelegatedAccount(balance), "confirmed"),
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

/** What the deposit key holds in the rollup, read through its own session, on the same terms as `heldInRollup`. */
export async function keyHeldInRollup(env: TransferEnv): Promise<bigint | null> {
  const key = env.depositKey.publicKey;
  if (!(await delegatedTo(env, depositKeyBalance(key, env.mint)))) return 0n;
  return readTokenBalance(await env.depositRollup(), depositKeyAccount(key, env.mint));
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
  const records = (await env.journal.unfinished(env.owner.toBase58())).filter(
    (record) => !isKeySweep(record),
  );
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
 * Judges the payments of spare SOL from the deposit key to the owner that are
 * still on record before a new transfer starts. One that can never land is
 * dropped; one that landed is closed once final. Until then the start stops
 * with a plain wait: a payment that may still land, or one that landed but is
 * not final, would let the key's balance be read from before it, and the new
 * transfer would send the key too little SOL.
 */
async function settleKeySweeps(env: TransferEnv): Promise<Stopped | null> {
  const owner = env.owner.toBase58();
  const stillReturning = (id: string) =>
    waiting(
      id,
      "Your deposit key is still returning its spare SOL to your wallet. Wait a moment and try again. Nothing was sent.",
    );
  for (const sweep of (await env.journal.unfinished(owner)).filter(isKeySweep)) {
    const judged = await reconciled(env, sweep.id, sweep.sends, undefined);
    if ("status" in judged) return stillReturning(sweep.id);
    if (!judged.landed) await env.journal.finish(owner, sweep.id);
    else if (!(await finishWhenFinalized(env, sweep.id))) return stillReturning(sweep.id);
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
  resumeId?: string,
): Promise<{ id: string; record: OperationRecord | null } | Stopped> {
  const owner = env.owner.toBase58();
  for (const done of await env.journal.unfinished(owner)) {
    if (done.step === "deposit" && done.seat?.state === "landed") {
      await finishWhenFinalized(env, done.id);
    }
  }
  const stillSweeping = await settleKeySweeps(env);
  if (stillSweeping) return stillSweeping;
  const current = currentRecord(
    (await env.journal.unfinished(owner)).filter((record) => !isKeySweep(record)),
  );
  if (resumeId !== undefined && current?.id !== resumeId) {
    return refuse(
      "record-changed",
      "This transfer already finished, perhaps in another tab. Nothing was sent.",
    );
  }
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
    /** The transaction's own instructions; the compute budget is put in front here, its unit limit from the simulation. */
    instructions: TransactionInstruction[];
    /** The exact transaction these instructions must make. */
    shape: TransferShape;
    /** Which step of a deposit through the deposit key this is. The key then pays and signs the transaction alone, with no wallet; without it the owner pays and signs. */
    leg?: SendLeg;
    /** The token account on Solana before this send that pays, and what it is to move. */
    before: bigint;
    moved: bigint;
  },
): Promise<Refused | { signature: string; broadcastError: string | null }> {
  const { blockhash, lastValidBlockHeight } = await freshBlockhash(env.solana);
  const keyed = plan.leg === "move" || plan.leg === "return" || plan.leg === "sweep";
  const payer = keyed ? env.depositKey.publicKey : env.owner;
  const built = (units?: number, microLamports?: number) =>
    new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight }).add(
      ...withComputeBudget(plan.instructions, units, microLamports),
    );
  const probe = built();
  const unsafe = await shapeRefusal(env, probe, plan.shape);
  if (unsafe) return notAllowed(unsafe);
  let simulated: Awaited<ReturnType<typeof simulation>>;
  try {
    simulated = await simulation(env.solana, probe);
  } catch (error) {
    return refuse(
      "simulation-unavailable",
      `Solana could not be asked to simulate the transaction (${(error as Error).message.split("\n")[0]}), so it is not sent. Nothing was sent.`,
    );
  }
  if (simulated.error !== null) {
    return refuse(
      "simulation-failed",
      `Solana would refuse the transaction with ${simulated.error}. Nothing was sent.`,
    );
  }
  const written = new Map<string, PublicKey>();
  for (const instruction of plan.instructions) {
    for (const key of instruction.keys) {
      if (key.isWritable) written.set(key.pubkey.toBase58(), key.pubkey);
    }
  }
  const transaction = built(
    computeUnitsAfterSimulation(plan.instructions.length, simulated.unitsConsumed),
    microLamportsFromFees(await recentPrioritizationFees(env.solana, [...written.values()])),
  );
  let signed = transaction;
  if (keyed) transaction.sign(env.depositKey);
  else signed = await env.signChecked(transaction, plan.shape, "solana:mainnet");
  let raw: Uint8Array;
  try {
    raw = signed.serialize();
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("Transaction too large"))
      throw error;
    return refuse(
      "transaction-not-allowed",
      `Your wallet added instructions that make the transaction larger than the ${PACKET_DATA_SIZE} bytes Solana allows. Nothing was sent.`,
    );
  }
  const owner = env.owner.toBase58();
  let broadcastError: string | null = null;
  const { signature } = await recordThenBroadcast({
    journal: env.journal,
    owner,
    op: {
      id: plan.id,
      kind: plan.kind,
      atoms: plan.atoms.toString(),
      step: plan.step,
      rollupBefore: plan.rollupBefore?.toString(),
      depositKey: plan.leg ? env.depositKey.publicKey.toBase58() : undefined,
    },
    lastValidBlockHeight,
    before: plan.before.toString(),
    moved: plan.moved.toString(),
    leg: plan.leg,
    signedTx: raw,
    broadcast: (bytes) =>
      env.solana.sendRawTransaction(bytes, { preflightCommitment: "confirmed" }).catch((error) => {
        broadcastError = broadcastErrorText(error);
        return null;
      }),
  });
  if (broadcastError) console.warn("The first broadcast of a transfer failed:", broadcastError);
  const result = await confirmSignature(env.solana, signature, {
    clock: env.clock,
    timeoutMs: SOLANA_ARRIVES_WITHIN_MS,
    lastValidBlockHeight,
    rebroadcast: raw,
  });
  if (result.seen) await env.journal.markSeen(owner, plan.id, signature, result.seen);
  return { signature, broadcastError };
}

/**
 * What a failed broadcast says, as one short line safe to show: the first line
 * of the error, with any sign-in token and every address removed.
 */
export function broadcastErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = redactToken(text.split("\n")[0]).replace(/\bhttps?:\/\/\S+/g, "[address]");
  return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}

/** `message` with the broadcast error the network gave, when there was one, so a wait is not silent about why. */
export const withBroadcastError = (message: string, error: string | null | undefined) =>
  error ? `${message} The network answered the send with: ${error}.` : message;

/**
 * Judges each send an earlier run wrote down before another is built: a send
 * that landed is returned, one that failed or can never land is dropped, and
 * one that may still land stops the run until its blockhash has expired and
 * the finalized chain has passed it.
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
      clock: env.clock,
    });
    if (verdict === "landed") landed = send;
    if (verdict === "wait") {
      return waiting(
        id,
        send.status !== undefined
          ? `The transaction ${send.signature} has been seen on Solana but is not confirmed yet. It can still land until the network has finalized past block height ${send.lastValidBlockHeight}, and it is judged again then. Nothing more is sent until that has passed.`
          : `The transaction ${send.signature} is not on Solana yet and can still land until block height ${send.lastValidBlockHeight}. Nothing more is sent until that has passed.`,
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
  return recordedRollupSend(env, id, raw, lastValidBlockHeight, before);
}

/**
 * Signs a rollup transaction with the deposit key as its fee payer and only
 * signer, and writes it to the journal before anything is sent, like
 * `signedAndRecordedOnRollup` but without the wallet. `before` is the deposit
 * key's rollup balance now. The rollup charges no fee, as for an order key.
 */
export async function signedByDepositKey(
  env: TransferEnv,
  id: string,
  instructions: TransactionInstruction[],
  shape: TransferShape,
  before: bigint,
): Promise<Refused | { raw: Uint8Array; signature: string; seatId: string }> {
  const signed = await signedWithDepositKey(env, instructions, shape, before);
  if ("status" in signed) return signed;
  await env.journal.recordSeatSend(env.owner.toBase58(), id, signed.seat);
  return signed;
}

/** The deposit key's signed rollup transaction and the pending seat record that names it, not yet written anywhere. */
export async function signedWithDepositKey(
  env: TransferEnv,
  instructions: TransactionInstruction[],
  shape: TransferShape,
  before: bigint,
): Promise<Refused | { raw: Uint8Array; signature: string; seatId: string; seat: SeatSend }> {
  const { blockhash, lastValidBlockHeight } = await freshBlockhash(await env.depositRollup());
  const transaction = new Transaction({
    feePayer: env.depositKey.publicKey,
    blockhash,
    lastValidBlockHeight,
  }).add(...instructions);
  const unsafe = await shapeRefusal(env, transaction, shape);
  if (unsafe) return notAllowed(unsafe);
  transaction.sign(env.depositKey);
  return pendingSeat(env, transaction.serialize(), lastValidBlockHeight, before, {
    signer: "deposit-key",
  });
}

function pendingSeat(
  env: TransferEnv,
  raw: Uint8Array,
  lastValidBlockHeight: number,
  before: bigint,
  by: Pick<SeatSend, "signer"> = {},
) {
  const signature = signatureOf(raw);
  const seatId = env.newId();
  const seat: SeatSend = {
    state: "pending",
    at: new Date(env.clock.now()).toISOString(),
    id: seatId,
    before: before.toString(),
    ...by,
    signature,
    lastValidBlockHeight,
  };
  return { raw, signature, seatId, seat };
}

async function recordedRollupSend(
  env: TransferEnv,
  id: string,
  raw: Uint8Array,
  lastValidBlockHeight: number,
  before: bigint,
) {
  const sent = pendingSeat(env, raw, lastValidBlockHeight, before);
  await env.journal.recordSeatSend(env.owner.toBase58(), id, sent.seat);
  return { raw, signature: sent.signature, seatId: sent.seatId };
}

export type RollupSendState =
  /** Its status shows success; `finalized` is whether that can no longer be undone. */
  | { kind: "landed"; finalized: boolean }
  /** Its status shows an error at finalized commitment, so it moved nothing and cannot be replayed. */
  | { kind: "failed"; error: string }
  | { kind: "pending" }
  /** Never seen at processed or better, its blockhash expired, and the status was read as absent twice, apart. */
  | { kind: "not-seen" }
  /** Seen at processed or better once, and the status is missing now: a lagging node may not show it, so it is never taken as unable to land. Reading again settles it. */
  | { kind: "vanished" }
  /** The status could not be read just now. Never taken as absent; reading again settles it. */
  | { kind: "unreadable" }
  /** The send was not written down with its signature, so there is nothing to look it up by. */
  | { kind: "unknown" };

/** One signed rollup transaction of a seat send, as it is looked up. */
interface Attempt {
  signature: string;
  /** Judged by whether this exact blockhash is still valid, for an order key's withdrawal. */
  blockhash?: string;
  /** Judged by the block height, for a send whose blockhash was read when it was signed. */
  lastValidBlockHeight?: number;
  seen: boolean;
}

const attemptsOf = (seat: SeatSend): Attempt[] =>
  seat.attempts
    ? seat.attempts.map((attempt) => ({ ...attempt, seen: attempt.seen === true }))
    : seat.signature && seat.lastValidBlockHeight !== undefined
      ? [
          {
            signature: seat.signature,
            lastValidBlockHeight: seat.lastValidBlockHeight,
            seen: seat.seen === true,
          },
        ]
      : [];

type Look =
  | { kind: "success"; finalized: boolean }
  | { kind: "failed"; error: string }
  /** Seen at processed, or with an error that is not final: in flight or not yet settled. */
  | { kind: "processed" }
  | { kind: "absent"; expired: boolean };

/** One look at an attempt. Whether it can still land is read before its status, so an attempt that lands between the two reads is seen and never taken as absent. */
async function lookAt(rollup: SolanaRpc, attempt: Attempt): Promise<Look> {
  const expired =
    attempt.blockhash !== undefined
      ? !(await rollup.isBlockhashValid(attempt.blockhash, { commitment: "confirmed" })).value
      : (await rollup.getBlockHeight("confirmed")) > (attempt.lastValidBlockHeight ?? Infinity);
  const { value } = await rollup.getSignatureStatus(attempt.signature, {
    searchTransactionHistory: true,
  });
  if (!value) return { kind: "absent", expired };
  if (value.confirmationStatus === "processed") return { kind: "processed" };
  if (value.err) {
    return value.confirmationStatus === "finalized"
      ? { kind: "failed", error: JSON.stringify(value.err) }
      : { kind: "processed" };
  }
  return { kind: "success", finalized: value.confirmationStatus === "finalized" };
}

/**
 * What a set of looks at every attempt of a send comes to. It landed if any
 * attempt did; it is in flight if any attempt is, or may still be, valid; a
 * missing status after any sighting is `vanished`, never unable to land; it
 * failed if every attempt was refused at finalized; and only attempts that
 * were never seen, are expired and are absent make `not-seen`, which the
 * caller confirms with a second look.
 */
function combined(attempts: Attempt[], looks: Look[]): RollupSendState | { kind: "candidate" } {
  const success = looks.find((look) => look.kind === "success");
  if (success) {
    const finalized = looks.some((look) => look.kind === "success" && look.finalized);
    return { kind: "landed", finalized };
  }
  if (looks.some((look) => look.kind === "processed")) return { kind: "pending" };
  const absent = looks.flatMap((look, at) => (look.kind === "absent" ? [{ look, at }] : []));
  if (absent.some(({ look }) => !look.expired)) return { kind: "pending" };
  if (absent.some(({ at }) => attempts[at].seen)) return { kind: "vanished" };
  const refused = looks.flatMap((look) => (look.kind === "failed" ? [look.error] : []));
  if (absent.length === 0 && refused.length > 0) return { kind: "failed", error: refused[0] };
  return { kind: "candidate" };
}

/**
 * Where a recorded rollup send stands, from the status of every signed attempt
 * of it. It is `landed` if any attempt succeeded (final once finalized), and
 * `failed` only once every attempt is refused at finalized (a confirmed error
 * may still be rolled back, so it waits). An attempt whose blockhash is still
 * valid is `pending`. Any sighting at processed or better is written to the
 * journal, and a status missing after one is `vanished`, never `not-seen`: only
 * a send that was never seen, whose blockhash has expired, and whose status was
 * read as absent twice, apart, is `not-seen`. Whether an attempt can still
 * land is read before its status, so one that lands between the reads is seen.
 * A balance never decides: the seat and the owner's token account can both be
 * moved by something else. A status read that fails is `unreadable`, never
 * absent. An order key's withdrawal the client proved from the account's own
 * view (`proven`) is final as recorded; otherwise it is judged by the attempts
 * written down just before they were dispatched, even once a status showed it
 * landed, and is final only at a finalized success. One with no attempts has
 * nothing to look up and is `unknown`, or as recorded if it was recorded landed
 * before attempts were kept. `id` is the operation's, and lets sightings be
 * written down.
 */
export async function rollupSendState(
  env: TransferEnv,
  seat: SeatSend,
  id?: string,
): Promise<RollupSendState> {
  const recordedLanded = seat.state === "landed";
  if (
    seat.signer === "order-key" &&
    recordedLanded &&
    (seat.proven === true || seat.attempts === undefined)
  ) {
    return { kind: "landed", finalized: true };
  }
  const attempts = attemptsOf(seat);
  if (attempts.length === 0) {
    return recordedLanded ? { kind: "landed", finalized: false } : { kind: "unknown" };
  }
  const owner = env.owner.toBase58();
  const settle = (state: RollupSendState): RollupSendState =>
    recordedLanded && (state.kind === "pending" || state.kind === "vanished")
      ? { kind: "landed", finalized: false }
      : state;
  const lookAll = async (rollup: SolanaRpc) => {
    const looks = await Promise.all(attempts.map((attempt) => lookAt(rollup, attempt)));
    for (const [at, look] of looks.entries()) {
      if (look.kind === "absent" || attempts[at].seen) continue;
      if (id !== undefined) await env.journal.markSeatSighted(owner, id, attempts[at].signature);
      attempts[at] = { ...attempts[at], seen: true };
    }
    return combined(attempts, looks);
  };
  try {
    const rollup = seat.signer === "deposit-key" ? await env.depositRollup() : env.rollup;
    const first = await lookAll(rollup);
    if (first.kind !== "candidate") return settle(first);
    await env.clock.sleep(MISSING_RECHECK_MS);
    const second = await lookAll(rollup);
    if (second.kind !== "candidate") return settle(second);
    return recordedLanded ? { kind: "landed", finalized: false } : { kind: "not-seen" };
  } catch {
    return recordedLanded ? { kind: "landed", finalized: false } : { kind: "unreadable" };
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
    const state = await rollupSendState(env, record.seat, record.id);
    if (state.kind !== "landed" || !state.finalized) return false;
  }
  try {
    for (const send of record.sends) {
      const height = await env.solana.getBlockHeight("confirmed");
      const { value } = await env.solana.getSignatureStatus(send.signature, {
        searchTransactionHistory: true,
      });
      if (value) {
        if (value.confirmationStatus !== "finalized") return false;
      } else if (height <= send.lastValidBlockHeight) {
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

/** Closes the records `ids` name once every send of all of them is final, and not before; false while any is not. */
export async function finishAllWhenFinal(env: TransferEnv, ids: string[]): Promise<boolean> {
  const owner = env.owner.toBase58();
  const closing = (await env.journal.unfinished(owner)).filter((record) => ids.includes(record.id));
  for (const record of closing) {
    if (!(await operationFinal(env, record))) return false;
  }
  for (const record of closing) await env.journal.finish(owner, record.id);
  return true;
}

/** The sends of an operation that move the tokens on Solana, as opposed to a token account's setup, which moves none. */
export const movingSends = (record: Pick<OperationRecord, "sends" | "atoms"> | undefined) =>
  (record?.sends ?? []).filter((send) => send.moved === record?.atoms);

/**
 * Drops the record of a withdrawal that stopped having sent nothing that
 * could have moved money: no seat withdrawal on record, no send that moves the
 * tokens, and every token account setup on record settled for good. Anything
 * else stays, and a record that is not there is nothing to do.
 */
export async function finishIfNothingSent(env: TransferEnv, id: string): Promise<void> {
  const owner = env.owner.toBase58();
  const record = (await env.journal.unfinished(owner)).find((candidate) => candidate.id === id);
  if (!record || record.seat || movingSends(record).length > 0) return;
  if (await operationFinal(env, record)) await env.journal.finish(owner, id);
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
  const state = await rollupSendState(env, seat, id);
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
      `The rollup transaction ${seat.signature} may still land until ${
        seat.lastValidBlockHeight === undefined
          ? "its blockhash expires"
          : `the rollup passes block height ${seat.lastValidBlockHeight}`
      }. Nothing is sent again.`,
    );
  }
  if (state.kind === "vanished") {
    return waiting(
      id,
      `The rollup transaction ${seat.signature} was seen, and its status is missing now. A node may be behind, so it may still be on the chain. It is read again next time; nothing is sent again.`,
    );
  }
  if (state.kind === "unreadable") {
    return waiting(
      id,
      `The status of the rollup transaction${seat.signature ? ` ${seat.signature}` : ""} could not be read just now. It is read again next time; nothing is sent again.`,
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
  if (seat.signer === "order-key") {
    return {
      status: "unknown",
      id,
      subject: "rollup-send",
      message:
        "We cannot tell whether this withdrawal went through, and it was not written down with a signature to look up. Check your wallet's token account in the rollup, or contact support with the transfer id. Nothing is sent again.",
      answers: [],
    };
  }
  return {
    status: "unknown",
    id,
    subject: "rollup-send",
    signature: seat.signature,
    message: `A rollup transaction cannot be placed: it was not written down with its signature. It cannot be dismissed. Wait, or contact support with the transfer id. Nothing is sent again.`,
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
  rollup: SolanaRpc = env.rollup,
  /** The operation's id: any sighting of the transaction is written to its record. */
  recordId?: string,
): Promise<
  | { state: "confirmed" }
  | { state: "failed"; error: string }
  | { state: "unconfirmed"; broadcastError: string | null }
> {
  let broadcastError: string | null = null;
  await rollup.sendRawTransaction(sent.raw, { skipPreflight: true }).catch((error) => {
    broadcastError = broadcastErrorText(error);
  });
  if (broadcastError) console.warn("The broadcast of a rollup transfer failed:", broadcastError);
  const result = await confirmSignature(rollup, sent.signature, {
    clock: env.clock,
    timeoutMs: ROLLUP_CONFIRMS_WITHIN_MS,
  });
  if (recordId !== undefined && result.seen !== undefined) {
    await env.journal.markSeatSighted(env.owner.toBase58(), recordId, sent.signature);
  }
  if (result.state === "confirmed") return { state: "confirmed" };
  if (result.state === "failed" && result.seen === "finalized") {
    return { state: "failed", error: result.error };
  }
  return { state: "unconfirmed", broadcastError };
}
