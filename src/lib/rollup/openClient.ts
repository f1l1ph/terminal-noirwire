import { PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import nacl from "tweetnacl";
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

/** What the service answers when it asks for a signed message instead of a signed transaction. */
const messagePrepareResponseSchema = z.object({
  expiresAt: z.number().int().positive(),
  expiresAtMs: z.number().finite(),
});

/** The least time a signed message must still be good for, and the most the program lets it run ahead, with a little for clock skew. */
const MESSAGE_MIN_VALIDITY_LEFT_MS = 15_000;
const MESSAGE_MAX_AHEAD_MS = 125_000;

const submitResponseSchema = z.object({ reference: z.string().min(1) });

const errorResponseSchema = z.object({ error: z.string() });

/** What the UI renders when the service turns an open request away. */
export type OpenRefusal =
  /** No invite for this address, or the code is wrong or missing. */
  | { kind: "notInvited" }
  /** The address is invited with a code, and none was sent. */
  | { kind: "inviteCodeNeeded" }
  /** A code was sent that does not match the address, or is not shaped like a code. */
  | { kind: "inviteCodeWrong" }
  | { kind: "inviteUsed" }
  | { kind: "accountOpen" }
  /** The desk is busy, the service is starting, or a short request throttle applies. */
  | { kind: "tryLater" }
  /** All of today's new accounts are given out; the count resets at 00:00 UTC. */
  | { kind: "dailyCapReached" }
  /** This network address already opened its account today. */
  | { kind: "addressLimit" }
  /** Nothing is prepared any more: prepare again. */
  | { kind: "prepareExpired" }
  /** The rollup did not answer in time: the account MAY be open. Read the view before retrying. */
  | { kind: "mayBeOpen" }
  | { kind: "unreachable" }
  | { kind: "badAnswer" }
  | { kind: "rejected"; status: number };

export type PrepareOpenOutcome =
  { kind: "prepared"; transaction: Transaction; expiresAtMs: number } | OpenRefusal;

export type PrepareOpenMessageOutcome =
  { kind: "prepared"; expiresAt: bigint; expiresAtMs: number } | OpenRefusal;

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

const DAILY_CAP_503: readonly string[] = [
  "today's new accounts are all given out: try again tomorrow, it resets at 00:00 UTC",
  "daily limit reached: no more new accounts can be opened today, try again tomorrow",
];

const NOTHING_SENT_503: readonly string[] = [
  "the service is still starting, try again",
  "the service is waking up, try again in a few seconds",
  "the rollup cannot be reached right now, try again",
  "the desk is busy with another request, try again",
  "the service is still starting, try again in a few seconds",
  "the gate could not write its seat record, so it signed nothing. Nothing changed: try again, and tell the operator if it keeps happening",
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
 * service has already signed as the gate (a wallet leaves a transaction that
 * carries a signature alone, and adds its own instructions to one that
 * carries none): the gate's signature must verify over the message, the
 * owner's slot must be empty, and there must be no other slot.
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
  const slots = transaction.signatures;
  if (slots.length !== 2 || !slots[0].publicKey.equals(gate) || !slots[1].publicKey.equals(owner)) {
    return "the transaction does not have exactly the gate's and the owner's signature slots";
  }
  if (slots[1].signature !== null) return "the owner's signature slot is not empty";
  const gateSignature = slots[0].signature;
  if (gateSignature === null) return "the gate has not signed the transaction";
  if (!nacl.sign.detached.verify(transaction.serializeMessage(), gateSignature, gate.toBytes())) {
    return "the gate's signature does not verify over the transaction";
  }
  const expected = programInstructions(programId).openTrader(gate, owner, [...orderKeys]);
  // The fee payer is writable once the message is compiled, though the builder marks the gate a plain signer.
  expected.keys[0] = { ...expected.keys[0], isWritable: true };
  if (!sameInstruction(transaction.instructions[0], expected)) {
    return "the instruction is not the expected account opening";
  }
  return null;
}

/**
 * Why a prepared expiry must not be signed for, or null when the message has
 * time enough left for the wallet and is not further ahead than the program
 * allows. The expiry is the rollup's clock as the service read it; `nowMs` is
 * this device's own clock, so the window carries a little slack for skew.
 */
export function isExpectedOpenWindow(expiresAtMs: number, nowMs: number): string | null {
  if (!Number.isFinite(expiresAtMs)) return "the prepared expiry is not a time";
  const left = expiresAtMs - nowMs;
  if (left < MESSAGE_MIN_VALIDITY_LEFT_MS) return "the prepared request is about to expire";
  if (left > MESSAGE_MAX_AHEAD_MS)
    return "the prepared request expires later than the program allows";
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
    if (/cannot be read/i.test(reason)) return { kind: "tryLater" };
    if (/invited with a code/i.test(reason)) return { kind: "inviteCodeNeeded" };
    if (/invite code does not match/i.test(reason)) return { kind: "inviteCodeWrong" };
    return { kind: "notInvited" };
  }
  if (status === 409) {
    if (/invite has been used/i.test(reason)) return { kind: "inviteUsed" };
    return ACCOUNT_EXISTS_409.includes(reason) ? { kind: "accountOpen" } : { kind: "mayBeOpen" };
  }
  if (status === 410) return { kind: "prepareExpired" };
  if (status === 429) {
    return /opened its account for today/i.test(reason)
      ? { kind: "addressLimit" }
      : { kind: "tryLater" };
  }
  if (status === 503 && DAILY_CAP_503.includes(reason)) return { kind: "dailyCapReached" };
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
  if (invite !== undefined && !INVITE_PATTERN.test(invite)) return { kind: "inviteCodeWrong" };
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
 * Step one on a deployment that opens accounts from a signed message: the same
 * request as `prepareOpen`, answered with the expiry the owner's message must
 * carry (the rollup's clock, unix seconds). Nothing comes back to sign: the
 * caller builds the message itself.
 */
export async function prepareOpenMessage(
  {
    simUrl,
    owner,
    orderKeys,
    invite,
  }: { simUrl: string; owner: string; orderKeys: string[]; invite?: string },
  fetchFn: typeof fetch = fetch,
): Promise<PrepareOpenMessageOutcome> {
  if (invite !== undefined && !INVITE_PATTERN.test(invite)) return { kind: "inviteCodeWrong" };
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
  const parsed = messagePrepareResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return { kind: "badAnswer" };
  return {
    kind: "prepared",
    expiresAt: BigInt(parsed.data.expiresAt),
    expiresAtMs: parsed.data.expiresAtMs,
  };
}

/**
 * Step two on a deployment that opens accounts from a signed message
 * (`POST /v1/open/submit`): the owner's 64-byte signature and the expiry it was
 * made for. The service rebuilds the message, checks the signature and sends
 * the open itself. An unanswered request may still have reached the rollup, so
 * it reads as `mayBeOpen`.
 */
export async function submitOpenMessage(
  {
    simUrl,
    owner,
    signature,
    expiresAt,
  }: { simUrl: string; owner: string; signature: Uint8Array; expiresAt: bigint },
  fetchFn: typeof fetch = fetch,
): Promise<SubmitOpenOutcome> {
  const response = await post(
    simUrl,
    "/v1/open/submit",
    { owner, signature: Buffer.from(signature).toString("base64"), expiresAt: Number(expiresAt) },
    fetchFn,
  );
  if (!response) return { kind: "mayBeOpen" };
  if (!response.ok) {
    return openRefusalOf(response.status, await errorReasonOf(response), "submit");
  }
  const parsed = submitResponseSchema.safeParse(await response.json().catch(() => null));
  return parsed.success
    ? { kind: "submitted", reference: parsed.data.reference }
    : { kind: "mayBeOpen" };
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
