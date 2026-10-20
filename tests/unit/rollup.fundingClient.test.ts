import { describe, expect, it, vi } from "vitest";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { openAndFund } from "@/lib/rollup/fundingClient";
import { PACKAGE_PROGRAM_ID, programInstructions } from "@/lib/rollup/sdk";

const GATE = Keypair.generate();
const FAUCET = Keypair.generate();
const FAUCET_TOKENS = Keypair.generate().publicKey;
const MINT = Keypair.generate().publicKey;
const GRANT = "5000.000000";
const GRANT_ATOMS = 5_000_000_000n;

interface Shape {
  feePayer?: PublicKey;
  programId?: PublicKey;
  orderKeys?: PublicKey[];
  amount?: bigint;
  /** Who the deposit says it is from (default: the faucet). */
  depositor?: PublicKey;
  /** Replaces the deposit, keeping the two-instruction shape. */
  second?: TransactionInstruction;
  /** Marks the owner writable in `open_trader`, which lets the transaction spend from it. */
  ownerWritable?: boolean;
  extra?: Parameters<Transaction["add"]>[number];
}

/**
 * The transaction sim-noirwire's `/v1/fund/prepare` builds (its
 * `openAndFundTransaction`): `open_trader` from the gate, which pays the
 * fee, then a collateral `deposit` of the grant from the faucet. Unsigned.
 */
function preparedTransactionBase64(owner: Keypair, orderKeys: PublicKey[], shape: Shape = {}) {
  const instructions = programInstructions(shape.programId ?? PACKAGE_PROGRAM_ID);
  const open = instructions.openTrader(
    GATE.publicKey,
    owner.publicKey,
    shape.orderKeys ?? orderKeys,
  );
  if (shape.ownerWritable) open.keys[1] = { ...open.keys[1], isWritable: true };
  const transaction = new Transaction({
    feePayer: shape.feePayer ?? GATE.publicKey,
    blockhash: Keypair.generate().publicKey.toBase58(), // any 32-byte base58 value serializes fine as a stand-in
    lastValidBlockHeight: 0,
  }).add(
    open,
    shape.second ??
      instructions.deposit(
        shape.depositor ?? FAUCET.publicKey,
        FAUCET_TOKENS,
        MINT,
        owner.publicKey,
        { collateral: true },
        shape.amount ?? GRANT_ATOMS,
      ),
  );
  if (shape.extra) transaction.add(shape.extra);
  return transaction
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function orderKeys(count = 4): PublicKey[] {
  return Array.from({ length: count }, () => Keypair.generate().publicKey);
}

async function signedByOwner(owner: Keypair, keys: PublicKey[], shape: Shape) {
  let submitted: string | null = null;
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/v1/fund/prepare")) {
      return jsonResponse({
        transaction: preparedTransactionBase64(owner, keys, shape),
        expiresAtMs: Date.now() + 45_000,
        amount: GRANT,
      });
    }
    submitted = (JSON.parse(String(init?.body)) as { transaction: string }).transaction;
    return jsonResponse({ amount: GRANT, reference: "sig-123" });
  }) as unknown as typeof fetch;
  const outcome = await openAndFund(
    "http://sim.test",
    owner,
    keys.map((key) => key.toBase58()),
    fetchFn,
  );
  return { outcome, submitted };
}

describe("openAndFund: the two-step open-and-fund flow", () => {
  it("prepares, signs with the owner key only, and submits, returning the grant", async () => {
    const owner = Keypair.generate();
    const keys = orderKeys();
    const transaction = preparedTransactionBase64(owner, keys);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ transaction, expiresAtMs: Date.now() + 45_000, amount: GRANT }),
      )
      .mockResolvedValueOnce(jsonResponse({ amount: GRANT, reference: "sig-123" }));

    const outcome = await openAndFund(
      "http://sim.test",
      owner,
      keys.map((key) => key.toBase58()),
      fetchFn,
    );

    expect(outcome).toEqual({ kind: "granted", amount: GRANT, reference: "sig-123" });
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
    const transaction = preparedTransactionBase64(owner, []);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ transaction, expiresAtMs: Date.now() + 45_000, amount: GRANT }),
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
    const transaction = preparedTransactionBase64(owner, []);
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ transaction, expiresAtMs: Date.now() + 45_000, amount: GRANT }),
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

describe("openAndFund: the prepared transaction is checked before the owner signs it", () => {
  const owner = Keypair.generate();
  const thief = Keypair.generate().publicKey;
  const keys = orderKeys();

  const refused: [string, Shape][] = [
    [
      "an appended transfer of the owner's lamports",
      {
        extra: SystemProgram.transfer({
          fromPubkey: owner.publicKey,
          toPubkey: thief,
          lamports: 5_000_000_000,
        }),
      },
    ],
    [
      "an appended withdraw signed by the owner",
      {
        extra: programInstructions(PACKAGE_PROGRAM_ID).withdraw(
          owner.publicKey,
          thief,
          MINT,
          { collateral: true },
          GRANT_ATOMS,
        ),
      },
    ],
    ["open_trader carrying order keys this client did not send", { orderKeys: orderKeys() }],
    ["the owner as the fee payer", { feePayer: owner.publicKey }],
    ["another program", { programId: Keypair.generate().publicKey }],
    ["a deposit other than the announced grant", { amount: 1n }],
    [
      "a withdraw in place of the deposit",
      {
        second: programInstructions(PACKAGE_PROGRAM_ID).withdraw(
          owner.publicKey,
          thief,
          MINT,
          { collateral: true },
          GRANT_ATOMS,
        ),
      },
    ],
    ["open_trader with the owner writable", { ownerWritable: true }],
    ["a deposit from the owner", { depositor: owner.publicKey }],
  ];

  it.each(refused)("refuses to sign %s", async (_case, shape) => {
    const { outcome, submitted } = await signedByOwner(owner, keys, shape);
    expect(outcome.kind).toBe("error");
    expect(submitted).toBeNull();
  });

  it("signs the expected shape", async () => {
    const { outcome, submitted } = await signedByOwner(owner, keys, {});
    expect(outcome.kind).toBe("granted");
    expect(submitted).not.toBeNull();
  });
});
