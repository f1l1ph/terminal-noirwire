import { Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { z } from "zod";
import type { FundOutcome } from "../trading/types";
import { PACKAGE_PROGRAM_ID, programInstructions, type CustodyToken } from "./sdk";
import { amountToQuoteAtoms } from "./units";

const prepareResponseSchema = z.object({
  transaction: z.string().min(1),
  expiresAtMs: z.number(),
  amount: z.string(),
});

const submitResponseSchema = z.object({
  amount: z.string(),
  reference: z.string(),
});

const errorResponseSchema = z.object({ error: z.string() });

const UNEXPECTED_TRANSACTION =
  "The service's funding transaction was not the expected one, so this wallet did not sign it.";

/**
 * The service's own reason for a 503 from `/v1/fund/*` on a deployment that
 * hands out no test funds (`NO_FAUCET` in sim-noirwire's rollup wiring).
 */
const NO_FAUCET_REASON = /no faucet/i;

function sameInstruction(
  actual: TransactionInstruction,
  expected: TransactionInstruction,
): boolean {
  return (
    actual.programId.equals(expected.programId) &&
    actual.data.equals(expected.data) &&
    actual.keys.length === expected.keys.length &&
    actual.keys.every((key, index) => key.pubkey.equals(expected.keys[index].pubkey))
  );
}

/**
 * Whether a prepared transaction is exactly the one this flow asks for, and
 * nothing else the owner's signature could authorise: fee paid by someone
 * other than the owner, and exactly two instructions, both to this build's
 * own program - `open_trader` from the gate (the fee payer) for this owner
 * with exactly the order keys this client sent, then a collateral
 * `deposit` of exactly the announced amount to this owner's view, into the
 * custody of `collateral` (the Exchange's own collateral token, read from
 * the Exchange account), from a depositor that is not the owner and naming
 * the owner nowhere. Only the depositor and its token account are the
 * service's to choose.
 */
function isExpectedFunding(
  transaction: Transaction,
  owner: PublicKey,
  orderKeys: readonly PublicKey[],
  collateral: CustodyToken,
  programId: PublicKey,
  amountAtoms: bigint,
): boolean {
  const { feePayer, instructions } = transaction;
  if (!feePayer || feePayer.equals(owner) || instructions.length !== 2) return false;
  const [open, deposit] = instructions;
  const program = programInstructions(programId);

  const expectedOpen = program.openTrader(feePayer, owner, [...orderKeys]);
  const ownerKey = open.keys[1];
  if (!sameInstruction(open, expectedOpen) || ownerKey.isWritable) return false;

  const depositor = deposit.keys[0]?.pubkey;
  const from = deposit.keys[6]?.pubkey;
  if (!depositor || !from) return false;
  const expectedDeposit = program.deposit(
    depositor,
    from,
    collateral,
    owner,
    { collateral: true },
    amountAtoms,
  );
  return (
    sameInstruction(deposit, expectedDeposit) &&
    !deposit.keys.some((key) => key.pubkey.equals(owner))
  );
}

/**
 * sim-noirwire's two-step "fund the real program" flow
 * (`src/http/routes/fund-rollup.ts`, `src/rollup/funding-desk.ts`, both read
 * from that repository): `prepare` returns one transaction that opens the
 * caller's account AND deposits the grant, with no signature yet; the
 * browser checks it is exactly that (`isExpectedFunding`), adds the owner's
 * signature and the service completes it with the gate's and the faucet's,
 * then sends it. This is the only step that needs the service at all; every
 * other trading action goes straight from the browser to the rollup.
 */
export async function openAndFund(
  simUrl: string,
  owner: Keypair,
  orderKeyPublicKeys: string[],
  collateral: CustodyToken,
  fetchFn: typeof fetch = fetch,
  programId: PublicKey = PACKAGE_PROGRAM_ID,
): Promise<FundOutcome> {
  const ownerAddress = owner.publicKey.toBase58();
  let prepareResponse: Response;
  try {
    prepareResponse = await fetchFn(`${simUrl}/v1/fund/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ owner: ownerAddress, orderKeys: orderKeyPublicKeys }),
    });
  } catch {
    return { kind: "error", message: `Could not reach the simulation service at ${simUrl}` };
  }
  if (!prepareResponse.ok) return await asFundOutcome(prepareResponse);
  const prepared = prepareResponseSchema.parse(await prepareResponse.json());

  let transaction: Transaction;
  try {
    transaction = Transaction.from(Buffer.from(prepared.transaction, "base64"));
    const expected = isExpectedFunding(
      transaction,
      owner.publicKey,
      orderKeyPublicKeys.map((key) => new PublicKey(key)),
      collateral,
      programId,
      amountToQuoteAtoms(prepared.amount),
    );
    if (!expected) return { kind: "error", message: UNEXPECTED_TRANSACTION };
  } catch {
    return { kind: "error", message: UNEXPECTED_TRANSACTION };
  }
  transaction.partialSign(owner);
  const submitted = transaction
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");

  let submitResponse: Response;
  try {
    submitResponse = await fetchFn(`${simUrl}/v1/fund/submit`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ owner: ownerAddress, transaction: submitted }),
    });
  } catch {
    return { kind: "error", message: `Could not reach the simulation service at ${simUrl}` };
  }
  if (!submitResponse.ok) return await asFundOutcome(submitResponse);
  const funded = submitResponseSchema.parse(await submitResponse.json());
  return { kind: "granted", amount: funded.amount, reference: funded.reference };
}

/**
 * 409 = already funded or (submit, rollup mode) the account already exists
 * (the per-owner one-grant rule); 429 = the per-IP rate limit; 503 = no
 * seat could be offered right now, the service is still starting, or
 * (rollup mode submit) the venue's own daily limit on new accounts
 * (`DAILY_SEAT_LIMIT_ERROR`, `src/rollup/funding-desk.ts` in sim-noirwire) -
 * all three are transient, so `rateLimited` covers them, carrying the
 * server's own reason when it gave one so the daily-limit case reads as
 * itself rather than the generic per-IP copy. Anything else (400, 410, 502)
 * is a genuine error: a malformed request, a prepare that expired before
 * submit, or the rollup not confirming in time. A 503 that says the
 * deployment has no faucet is not transient: it is `noFaucet`, never worth
 * asking again.
 */
async function asFundOutcome(response: Response): Promise<FundOutcome> {
  const body = await response.json().catch(() => null);
  const parsed = errorResponseSchema.safeParse(body);
  const reason = parsed.success ? parsed.data.error : undefined;
  if (response.status === 409) return { kind: "alreadyFunded" };
  if (response.status === 503 && reason && NO_FAUCET_REASON.test(reason)) {
    return { kind: "noFaucet" };
  }
  if (response.status === 429 || response.status === 503) {
    return { kind: "rateLimited", message: reason };
  }
  return {
    kind: "error",
    message: reason ?? `the service answered ${response.status}`,
  };
}
