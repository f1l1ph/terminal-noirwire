import { describe, expect, it, vi } from "vitest";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { openAndFund } from "@/lib/rollup/fundingClient";

const GATE = Keypair.generate();

/** A structurally real, unsigned transaction, standing in for what sim-noirwire's `/v1/fund/prepare` returns (DESIGN.md, "Funding a user"): fee payer is the gate, so the owner's signature alone is not enough to send it, matching the real two-step flow. */
function preparedTransactionBase64(owner: Keypair): string {
  const transaction = new Transaction({
    feePayer: GATE.publicKey,
    blockhash: Keypair.generate().publicKey.toBase58(), // any 32-byte base58 value serializes fine as a stand-in
    lastValidBlockHeight: 0,
  }).add(
    SystemProgram.transfer({
      fromPubkey: GATE.publicKey,
      toPubkey: owner.publicKey,
      lamports: 0,
    }),
  );
  // The owner is not a party to this particular instruction, but the real
  // prepared transaction always names the owner as a required signer
  // (open_trader); add it as an explicit signer slot the same way.
  transaction.instructions[0].keys.push({
    pubkey: owner.publicKey,
    isSigner: true,
    isWritable: false,
  });
  return transaction
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe("openAndFund: the two-step open-and-fund flow", () => {
  it("prepares, signs with the owner key only, and submits, returning the grant", async () => {
    const owner = Keypair.generate();
    const transaction = preparedTransactionBase64(owner);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ transaction, expiresAtMs: Date.now() + 45_000, amount: "5000.000000" }),
      )
      .mockResolvedValueOnce(jsonResponse({ amount: "5000.000000", reference: "sig-123" }));

    const outcome = await openAndFund(
      "http://sim.test",
      owner,
      [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()],
      fetchFn,
    );

    expect(outcome).toEqual({ kind: "granted", amount: "5000.000000", reference: "sig-123" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [prepareUrl, prepareInit] = fetchFn.mock.calls[0];
    expect(prepareUrl).toBe("http://sim.test/v1/fund/prepare");
    expect(JSON.parse(prepareInit.body).owner).toBe(owner.publicKey.toBase58());

    const [submitUrl, submitInit] = fetchFn.mock.calls[1];
    expect(submitUrl).toBe("http://sim.test/v1/fund/submit");
    const submittedBody = JSON.parse(submitInit.body);
    expect(submittedBody.owner).toBe(owner.publicKey.toBase58());
    // The resubmitted transaction carries the owner's own signature, added
    // locally, and nobody else's yet (the service adds the gate's and the
    // faucet's after checking it).
    const resubmitted = Transaction.from(Buffer.from(submittedBody.transaction, "base64"));
    const ownerSignature = resubmitted.signatures.find((entry) =>
      entry.publicKey.equals(owner.publicKey),
    );
    expect(ownerSignature?.signature).not.toBeNull();
    expect(resubmitted.verifySignatures(false)).toBe(true);
  });

  it("reports a 409 from prepare (no fresh seat to reserve, already funded) as alreadyFunded", async () => {
    const owner = Keypair.generate();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: "this address already received its fund grant" }, 409),
      );
    const outcome = await openAndFund("http://sim.test", owner, [], fetchFn);
    expect(outcome).toEqual({ kind: "alreadyFunded" });
    expect(fetchFn).toHaveBeenCalledTimes(1); // never gets to sign or submit
  });

  it("reports a 503 from prepare (no seat could be offered) as rateLimited, a transient refusal", async () => {
    const owner = Keypair.generate();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: "no seat can be offered right now, try again" }, 503),
      );
    const outcome = await openAndFund("http://sim.test", owner, [], fetchFn);
    expect(outcome).toEqual({
      kind: "rateLimited",
      message: "no seat can be offered right now, try again",
    });
  });

  it("reports a 503 from submit (the venue's daily new-account limit) as rateLimited, carrying the venue's own reason", async () => {
    const owner = Keypair.generate();
    const transaction = preparedTransactionBase64(owner);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ transaction, expiresAtMs: Date.now() + 45_000, amount: "5000.000000" }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error:
              "daily limit reached: no more new accounts can be opened today, try again tomorrow",
          },
          503,
        ),
      );
    const outcome = await openAndFund("http://sim.test", owner, [], fetchFn);
    expect(outcome).toEqual({
      kind: "rateLimited",
      message: "daily limit reached: no more new accounts can be opened today, try again tomorrow",
    });
  });

  it("reports a 409 from submit (the seat was taken in between) as a genuine error, not success", async () => {
    const owner = Keypair.generate();
    const transaction = preparedTransactionBase64(owner);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ transaction, expiresAtMs: Date.now() + 45_000, amount: "5000.000000" }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error:
              "the account was not opened: it exists already, or its seat was taken. Prepare again",
          },
          409,
        ),
      );
    const outcome = await openAndFund("http://sim.test", owner, [], fetchFn);
    expect(outcome).toEqual({ kind: "alreadyFunded" });
  });

  it("surfaces a network failure as an error outcome, not a thrown exception", async () => {
    const owner = Keypair.generate();
    const fetchFn = vi.fn().mockRejectedValue(new Error("fetch failed"));
    const outcome = await openAndFund("http://sim.test", owner, [], fetchFn);
    expect(outcome.kind).toBe("error");
  });
});
