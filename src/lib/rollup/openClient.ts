import { PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { z } from "zod";
import { programInstructions } from "./sdk";

/** The invite pattern the service accepts on `/v1/open/prepare`. */
const INVITE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ORDER_KEYS_PER_TRADER = 4;
/** A prepared transaction is only worth signing while the service will still take it back. */
const MIN_VALIDITY_LEFT_MS = 10_000;

const prepareResponseSchema = z.object({
  transaction: z.string().min(1),
  expiresAtMs: z.number().finite(),
});

const submitResponseSchema = z.object({ reference: z.string().min(1) });

const errorResponseSchema = z.object({ error: z.string() });

/** What the UI renders when the service turns an open request away. */
export type OpenRefusal =
  /** No invite for this address, or the code is wrong or missing. */
  | { kind: "notInvited" }
  | { kind: "inviteUsed" }
  | { kind: "accountOpen" }
  /** The desk is busy, the day's new accounts are all given out, or the service is starting. */
  | { kind: "tryLater" }
  | { kind: "tooManyToday" }
  /** Nothing is prepared any more: prepare again. */
  | { kind: "prepareExpired" }
  /** The rollup did not answer in time: the account MAY be open. Read the view before retrying. */
  | { kind: "mayBeOpen" }
  | { kind: "unreachable" }
  | { kind: "badAnswer" }
  | { kind: "rejected"; status: number };

export type PrepareOpenOutcome =
  { kind: "prepared"; transaction: Transaction; expiresAtMs: number } | OpenRefusal;

export type SubmitOpenOutcome = { kind: "submitted"; reference: string } | OpenRefusal;

type Step = "prepare" | "submit";

/**
 * The exact 503 texts sim-noirwire sends from `/v1/open/submit` when it
 * refused before sending anything, or when the program refused for the day's
 * limit. A 503 with any other text (a proxy's page, an empty body) may have
 * come after the open was sent.
 */
const ACCOUNT_EXISTS_409: readonly string[] = [
  "this address has an account already. Nothing changed",
  "the account was not opened: it exists already. Nothing changed",
];

const NOTHING_SENT_503: readonly string[] = [
  "the service is still starting, try again",
  "the service is waking up, try again in a few seconds",
  "the rollup cannot be reached right now, try again",
  "the desk is busy with another request, try again",
  "the service is still starting, try again in a few seconds",
  "today's new accounts are all given out: try again tomorrow, it resets at 00:00 UTC",
  "the gate could not write its seat record, so it signed nothing. Nothing changed: try again, and tell the operator if it keeps happening",
  "daily limit reached: no more new accounts can be opened today, try again tomorrow",
];

function sameInstruction(
  actual: TransactionInstruction,
  expected: TransactionInstruction,
): boolean {
  return (
    actual.programId.equals(expected.programId) &&
    actual.data.equals(expected.data) &&
    actual.keys.length === expected.keys.length &&
    actual.keys.every(
      (key, index) =>
        key.pubkey.equals(expected.keys[index].pubkey) &&
        key.isSigner === expected.keys[index].isSigner &&
        key.isWritable === expected.keys[index].isWritable,
    )
  );
}

export interface ExpectedOpen {
  programId: PublicKey;
  /** The gate's key as read from the chain, never taken from the service's answer. */
  gate: PublicKey;
  owner: PublicKey;
  orderKeys: readonly PublicKey[];
  nowMs: number;
  expiresAtMs: number;
}

/**
 * Why a prepared open transaction must not be signed, or null when it is
 * exactly what this flow asks for: the gate pays the fee, and the one
 * instruction is `open_trader` to this build's own program, equal in every
 * account (with its signer and writable flags) and every data byte to the
 * one built here for this owner and exactly these four order keys. In that
 * builder the owner is a signer and not writable, so the owner's signature
 * cannot authorise moving anything out of the owner's own account. The
 * service leaves every signature slot empty, so any signature already on
 * the transaction is unexpected.
 */
export function isExpectedOpen(
  transaction: Transaction,
  { programId, gate, owner, orderKeys, nowMs, expiresAtMs }: ExpectedOpen,
): string | null {
  if (!Number.isFinite(expiresAtMs) || expiresAtMs - nowMs < MIN_VALIDITY_LEFT_MS) {
    return "the prepared transaction is about to expire";
  }
  if (orderKeys.length !== ORDER_KEYS_PER_TRADER) return "the order keys are not the four expected";
  const distinct = new Set([owner.toBase58(), ...orderKeys.map((key) => key.toBase58())]);
  if (distinct.size !== ORDER_KEYS_PER_TRADER + 1) {
    return "the order keys must differ from each other and from the owner";
  }
  if (orderKeys.some((key) => key.equals(PublicKey.default))) {
    return "an order key is the empty key";
  }
  if (!transaction.feePayer?.equals(gate)) return "the fee payer is not the gate";
  if (transaction.instructions.length !== 1) return "the transaction has other instructions";
  if (transaction.signatures.some((entry) => entry.signature !== null)) {
    return "the transaction already carries a signature";
  }
  const expected = programInstructions(programId).openTrader(gate, owner, [...orderKeys]);
  // The fee payer is writable once the message is compiled, though the builder marks the gate a plain signer.
  expected.keys[0] = { ...expected.keys[0], isWritable: true };
  if (!sameInstruction(transaction.instructions[0], expected)) {
    return "the instruction is not the expected account opening";
  }
  return null;
}

async function errorReasonOf(response: Response): Promise<string> {
  const body = await response.json().catch(() => null);
  const parsed = errorResponseSchema.safeParse(body);
  return parsed.success ? parsed.data.error : "";
}

/**
 * Maps one refusal of the open service to a result the UI can render. The
 * service's wording is matched only to tell apart refusals that share a
 * status; anything unmatched falls back to the safe reading of its status.
 * A 502 from `submit` means the rollup did not confirm: the account may be
 * open, so it is never a plain failure. A 502 from `prepare` built nothing.
 */
export function openRefusalOf(status: number, reason: string, step: Step): OpenRefusal {
  if (status === 403) {
    return /cannot be read/i.test(reason) ? { kind: "tryLater" } : { kind: "notInvited" };
  }
  if (status === 409) {
    if (/invite has been used/i.test(reason)) return { kind: "inviteUsed" };
    return ACCOUNT_EXISTS_409.includes(reason) ? { kind: "accountOpen" } : { kind: "mayBeOpen" };
  }
  if (status === 410) return { kind: "prepareExpired" };
  if (status === 429) {
    return /opened its account for today/i.test(reason)
      ? { kind: "tooManyToday" }
      : { kind: "tryLater" };
  }
  if (status === 503 && (step === "prepare" || NOTHING_SENT_503.includes(reason))) {
    return { kind: "tryLater" };
  }
  if (status >= 500) return step === "submit" ? { kind: "mayBeOpen" } : { kind: "tryLater" };
  return { kind: "rejected", status };
}

async function post(
  simUrl: string,
  path: string,
  body: unknown,
  fetchFn: typeof fetch,
): Promise<Response | null> {
  try {
    return await fetchFn(`${simUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
}

/**
 * Step one of opening an account on a deployment that admits invited people
 * only (sim-noirwire `POST /v1/open/prepare`): the service answers with the
 * one transaction that opens the owner's account, unsigned, valid for 45
 * seconds. The caller must run `isExpectedOpen` on it before signing.
 */
export async function prepareOpen(
  {
    simUrl,
    owner,
    orderKeys,
    invite,
  }: { simUrl: string; owner: string; orderKeys: string[]; invite?: string },
  fetchFn: typeof fetch = fetch,
): Promise<PrepareOpenOutcome> {
  if (invite !== undefined && !INVITE_PATTERN.test(invite)) return { kind: "notInvited" };
  const response = await post(
    simUrl,
    "/v1/open/prepare",
    invite === undefined ? { owner, orderKeys } : { owner, orderKeys, invite },
    fetchFn,
  );
  if (!response) return { kind: "unreachable" };
  if (!response.ok) {
    return openRefusalOf(response.status, await errorReasonOf(response), "prepare");
  }
  const parsed = prepareResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return { kind: "badAnswer" };
  try {
    return {
      kind: "prepared",
      transaction: Transaction.from(Buffer.from(parsed.data.transaction, "base64")),
      expiresAtMs: parsed.data.expiresAtMs,
    };
  } catch {
    return { kind: "badAnswer" };
  }
}

/**
 * Step two (`POST /v1/open/submit`): sends back the transaction signed by the
 * owner. The service adds the gate's signature and sends it. A request that
 * got no answer may still have reached the rollup, so it reads as `mayBeOpen`.
 */
export async function submitOpen(
  { simUrl, owner, signedTx }: { simUrl: string; owner: string; signedTx: Transaction },
  fetchFn: typeof fetch = fetch,
): Promise<SubmitOpenOutcome> {
  const transaction = signedTx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
  const response = await post(simUrl, "/v1/open/submit", { owner, transaction }, fetchFn);
  if (!response) return { kind: "mayBeOpen" };
  if (!response.ok) {
    return openRefusalOf(response.status, await errorReasonOf(response), "submit");
  }
  const parsed = submitResponseSchema.safeParse(await response.json().catch(() => null));
  return parsed.success
    ? { kind: "submitted", reference: parsed.data.reference }
    : { kind: "mayBeOpen" };
}
