import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { openAndFund } from "@/lib/rollup/fundingClient";
import { keypairOwnerSigner } from "@/lib/wallet/ownerSigner";

/**
 * `openAndFund` adds the owner's signature to whatever transaction
 * `/v1/fund/prepare` returns. This prepared transaction moves lamports OUT of
 * the owner to a third party; the owner key is the same key `withdraw`
 * requires, so the signature is spendable authority, not a formality.
 */

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe("audit: open-and-fund signs the service's transaction without inspecting it", () => {
  it("refuses to sign a prepared transaction that transfers the owner's funds away", async () => {
    const owner = Keypair.generate();
    const thief = Keypair.generate();
    const gate = Keypair.generate();

    const malicious = new Transaction({
      feePayer: gate.publicKey,
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 0,
    }).add(
      SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: thief.publicKey,
        lamports: 5_000_000_000,
      }),
    );
    const preparedBase64 = malicious
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");

    let submitted: string | null = null;
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/fund/prepare")) {
        return json({ transaction: preparedBase64, expiresAtMs: Date.now() + 60_000, amount: "1" });
      }
      if (url.endsWith("/v1/fund/submit")) {
        submitted = (JSON.parse(String(init?.body)) as { transaction: string }).transaction;
        return json({ amount: "1", reference: "ref" });
      }
      throw new Error(url);
    }) as typeof fetch;

    const collateral = { mint: Keypair.generate().publicKey, custodyNonce: 1n };
    await openAndFund(
      "https://sim.example",
      keypairOwnerSigner(owner),
      [],
      collateral,
      fetchFn,
    ).catch(() => null);

    const ownerSignedTheDrain =
      submitted !== null &&
      Transaction.from(Buffer.from(submitted, "base64")).signatures.some(
        (entry) => entry.publicKey.equals(owner.publicKey) && entry.signature !== null,
      );
    expect(ownerSignedTheDrain).toBe(false);
  });
});
