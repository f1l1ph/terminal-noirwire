import { Keypair, Transaction } from "@solana/web3.js";
import { z } from "zod";
import type { FundOutcome } from "../trading/types";

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

/**
 * sim-noirwire's two-step "fund the real program" flow
 * (`src/http/routes/fund-rollup.ts`, `src/rollup/funding-desk.ts`, both read
 * from that repository): `prepare` returns one transaction that opens the
 * caller's account AND deposits the grant, with no signature yet; the
 * browser adds the owner's signature and the service completes it with the
 * gate's and the faucet's, then sends it. This is the only step that needs
 * the service at all; every other trading action goes straight from the
 * browser to the rollup.
 */
export async function openAndFund(
  simUrl: string,
  owner: Keypair,
  orderKeyPublicKeys: string[],
  fetchFn: typeof fetch = fetch,
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

  const transaction = Transaction.from(Buffer.from(prepared.transaction, "base64"));
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
 * submit, or the rollup not confirming in time.
 */
async function asFundOutcome(response: Response): Promise<FundOutcome> {
  const body = await response.json().catch(() => null);
  const parsed = errorResponseSchema.safeParse(body);
  const reason = parsed.success ? parsed.data.error : undefined;
  if (response.status === 409) return { kind: "alreadyFunded" };
  if (response.status === 429 || response.status === 503) {
    return { kind: "rateLimited", message: reason };
  }
  return {
    kind: "error",
    message: reason ?? `the service answered ${response.status}`,
  };
}
