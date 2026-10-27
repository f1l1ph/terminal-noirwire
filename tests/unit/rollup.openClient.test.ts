import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  isExpectedOpen,
  prepareOpen,
  submitOpen,
  type ExpectedOpen,
} from "@/lib/rollup/openClient";
import { PACKAGE_PROGRAM_ID, programInstructions } from "@/lib/rollup/sdk";

const GATE = Keypair.generate();
const OWNER = Keypair.generate();
const ORDER_KEYS = Array.from({ length: 4 }, () => Keypair.generate().publicKey);
const NOW = 1_000_000;
const INVITE = "invite-code-123456";
const SIM_URL = "https://sim.example";

interface Shape {
  feePayer?: PublicKey;
  programId?: PublicKey;
  orderKeys?: PublicKey[];
  ownerWritable?: boolean;
  tamperData?: boolean;
  extra?: Parameters<Transaction["add"]>[number];
}

/** The transaction sim-noirwire's `openTransaction` builds: `open_trader` with the gate paying, unsigned. */
function preparedTransaction(shape: Shape = {}): Transaction {
  const open = programInstructions(shape.programId ?? PACKAGE_PROGRAM_ID).openTrader(
    GATE.publicKey,
    OWNER.publicKey,
    shape.orderKeys ?? ORDER_KEYS,
  );
  if (shape.ownerWritable) open.keys[1] = { ...open.keys[1], isWritable: true };
  if (shape.tamperData) open.data = Buffer.from(open.data.map((byte) => byte ^ 1));
  const transaction = new Transaction({
    feePayer: shape.feePayer ?? GATE.publicKey,
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 100,
  }).add(open);
  if (shape.extra) transaction.add(shape.extra);
  return transaction;
}

const serialized = (transaction: Transaction): Transaction =>
  Transaction.from(transaction.serialize({ requireAllSignatures: false, verifySignatures: false }));

/** The transaction as it was before the service signed it: no signature on it. */
const unsignedOnTheWire = serialized;

/** What `/v1/open/prepare` sends: signed by the gate as fee payer, the owner's slot left empty. */
function onTheWire(transaction: Transaction): Transaction {
  if (transaction.feePayer?.equals(GATE.publicKey)) transaction.partialSign(GATE);
  return serialized(transaction);
}

const expectation = (overrides: Partial<ExpectedOpen> = {}): ExpectedOpen => ({
  programId: PACKAGE_PROGRAM_ID,
  gate: GATE.publicKey,
  owner: OWNER.publicKey,
  orderKeys: ORDER_KEYS,
  nowMs: NOW,
  expiresAtMs: NOW + 45_000,
  ...overrides,
});

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const refusedWith = async (status: number, error: string, step: "prepare" | "submit") => {
  const fetchFn = vi.fn(async () => reply(status, { error }));
  if (step === "prepare") {
    return prepareOpen(
      { simUrl: SIM_URL, owner: OWNER.publicKey.toBase58(), orderKeys: [], invite: INVITE },
      fetchFn as unknown as typeof fetch,
    );
  }
  return submitOpen(
    { simUrl: SIM_URL, owner: OWNER.publicKey.toBase58(), signedTx: preparedTransaction() },
    fetchFn as unknown as typeof fetch,
  );
};

describe("isExpectedOpen", () => {
  it("accepts the transaction exactly as the service builds it", () => {
    expect(isExpectedOpen(onTheWire(preparedTransaction()), expectation())).toBeNull();
  });

  it("leaves the owner a non-writable signer, as the SDK builder does", () => {
    const [open] = preparedTransaction().instructions;
    expect(open.keys[1].pubkey.equals(OWNER.publicKey)).toBe(true);
    expect(open.keys[1].isSigner).toBe(true);
    expect(open.keys[1].isWritable).toBe(false);
  });

  it("refuses a fee payer other than the gate read from chain", () => {
    const transaction = onTheWire(preparedTransaction({ feePayer: OWNER.publicKey }));
    expect(isExpectedOpen(transaction, expectation())).not.toBeNull();
  });

  it("refuses a second instruction", () => {
    const transfer = SystemProgram.transfer({
      fromPubkey: OWNER.publicKey,
      toPubkey: GATE.publicKey,
      lamports: 1,
    });
    const transaction = onTheWire(preparedTransaction({ extra: transfer }));
    expect(isExpectedOpen(transaction, expectation())).not.toBeNull();
  });

  it("refuses an instruction to a different program", () => {
    const transaction = onTheWire(preparedTransaction({ programId: Keypair.generate().publicKey }));
    expect(isExpectedOpen(transaction, expectation())).not.toBeNull();
  });

  it("refuses order keys other than the four sent", () => {
    const foreign = [...ORDER_KEYS.slice(0, 3), Keypair.generate().publicKey];
    const transaction = onTheWire(preparedTransaction({ orderKeys: foreign }));
    expect(isExpectedOpen(transaction, expectation())).not.toBeNull();
  });

  it("refuses a writable owner", () => {
    const transaction = onTheWire(preparedTransaction({ ownerWritable: true }));
    expect(isExpectedOpen(transaction, expectation())).not.toBeNull();
  });

  it("refuses with less than 10 seconds left", () => {
    const transaction = onTheWire(preparedTransaction());
    expect(isExpectedOpen(transaction, expectation({ expiresAtMs: NOW + 9_999 }))).not.toBeNull();
    expect(isExpectedOpen(transaction, expectation({ expiresAtMs: NOW + 10_000 }))).toBeNull();
  });

  it("refuses changed instruction data", () => {
    const transaction = onTheWire(preparedTransaction({ tamperData: true }));
    expect(isExpectedOpen(transaction, expectation())).not.toBeNull();
  });

  it("refuses a transaction the gate has not signed", () => {
    expect(isExpectedOpen(unsignedOnTheWire(preparedTransaction()), expectation())).toBe(
      "the gate has not signed the transaction",
    );
  });

  it("refuses a gate signature that does not verify over the message", () => {
    const forged = serialized(preparedTransaction());
    forged.signatures[0].signature = Buffer.alloc(64, 9);
    expect(isExpectedOpen(forged, expectation())).toBe(
      "the gate's signature does not verify over the transaction",
    );
  });

  it("refuses a gate signature made over a different message", () => {
    const other = preparedTransaction();
    other.partialSign(GATE);
    const transaction = serialized(preparedTransaction());
    transaction.signatures[0].signature = other.signatures[0].signature;
    expect(isExpectedOpen(transaction, expectation())).toBe(
      "the gate's signature does not verify over the transaction",
    );
  });

  it("refuses a signature made by a key other than the gate", () => {
    const transaction = preparedTransaction();
    const impostor = Keypair.generate();
    transaction.feePayer = impostor.publicKey;
    transaction.partialSign(impostor);
    expect(isExpectedOpen(serialized(transaction), expectation())).not.toBeNull();
  });

  it("refuses an owner slot that is already filled", () => {
    const transaction = preparedTransaction();
    transaction.partialSign(GATE, OWNER);
    expect(isExpectedOpen(serialized(transaction), expectation())).toBe(
      "the owner's signature slot is not empty",
    );
  });

  it("refuses a signature slot beyond the gate's and the owner's", () => {
    const extra = Keypair.generate();
    const transaction = preparedTransaction();
    transaction.instructions[0].keys.push({
      pubkey: extra.publicKey,
      isSigner: true,
      isWritable: false,
    });
    transaction.partialSign(GATE);
    expect(isExpectedOpen(serialized(transaction), expectation())).not.toBeNull();
  });

  it("accepts the gate-signed transaction after the wire round trip", () => {
    const wire = onTheWire(preparedTransaction());
    expect(wire.signatures).toHaveLength(2);
    expect(wire.signatures[0].signature).not.toBeNull();
    expect(wire.signatures[1].signature).toBeNull();
    expect(isExpectedOpen(wire, expectation())).toBeNull();
  });
});

describe("isExpectedOpen order key rules", () => {
  it("refuses order keys that repeat", () => {
    const repeated = [ORDER_KEYS[0], ORDER_KEYS[0], ORDER_KEYS[2], ORDER_KEYS[3]];
    const transaction = onTheWire(preparedTransaction({ orderKeys: repeated }));
    expect(isExpectedOpen(transaction, expectation({ orderKeys: repeated }))).not.toBeNull();
  });

  it("refuses the empty key as an order key", () => {
    const withEmpty = [PublicKey.default, ...ORDER_KEYS.slice(1)];
    const transaction = onTheWire(preparedTransaction({ orderKeys: withEmpty }));
    expect(isExpectedOpen(transaction, expectation({ orderKeys: withEmpty }))).not.toBeNull();
  });

  it("refuses an order key equal to the owner", () => {
    const withOwner = [OWNER.publicKey, ...ORDER_KEYS.slice(1)];
    const transaction = onTheWire(preparedTransaction({ orderKeys: withOwner }));
    expect(isExpectedOpen(transaction, expectation({ orderKeys: withOwner }))).not.toBeNull();
  });
});

describe("prepareOpen", () => {
  it("refuses a malformed invite before any request", async () => {
    const fetchFn = vi.fn();
    const outcome = await prepareOpen(
      {
        simUrl: SIM_URL,
        owner: OWNER.publicKey.toBase58(),
        orderKeys: ORDER_KEYS.map((key) => key.toBase58()),
        invite: "not a valid code!",
      },
      fetchFn as unknown as typeof fetch,
    );
    expect(outcome.kind).toBe("inviteCodeWrong");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("sends the owner, the four order keys and the invite to the open endpoint", async () => {
    const transaction = preparedTransaction();
    transaction.partialSign(GATE);
    const fetchFn = vi.fn(async () =>
      reply(200, {
        transaction: transaction
          .serialize({ requireAllSignatures: false, verifySignatures: false })
          .toString("base64"),
        expiresAtMs: NOW + 45_000,
      }),
    );
    const orderKeys = ORDER_KEYS.map((key) => key.toBase58());
    const outcome = await prepareOpen(
      { simUrl: SIM_URL, owner: OWNER.publicKey.toBase58(), orderKeys, invite: INVITE },
      fetchFn as unknown as typeof fetch,
    );
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${SIM_URL}/v1/open/prepare`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      owner: OWNER.publicKey.toBase58(),
      orderKeys,
      invite: INVITE,
    });
    expect(outcome.kind).toBe("prepared");
    if (outcome.kind === "prepared") {
      expect(outcome.expiresAtMs).toBe(NOW + 45_000);
      expect(isExpectedOpen(outcome.transaction, expectation())).toBeNull();
    }
  });

  it("omits the invite field when the address is invited by itself", async () => {
    const fetchFn = vi.fn(async () => reply(403, { error: "x" }));
    await prepareOpen(
      { simUrl: SIM_URL, owner: OWNER.publicKey.toBase58(), orderKeys: [] },
      fetchFn as unknown as typeof fetch,
    );
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(Object.keys(JSON.parse(init.body as string))).not.toContain("invite");
  });

  it("reads an answer without a usable transaction as a bad answer", async () => {
    const fetchFn = vi.fn(async () => reply(200, { transaction: "!!!", expiresAtMs: NOW }));
    const outcome = await prepareOpen(
      { simUrl: SIM_URL, owner: OWNER.publicKey.toBase58(), orderKeys: [] },
      fetchFn as unknown as typeof fetch,
    );
    expect(outcome.kind).toBe("badAnswer");
  });
});

describe("submitOpen", () => {
  it("posts the owner and the base64 transaction and returns the reference", async () => {
    const fetchFn = vi.fn(async () => reply(200, { reference: "sig123" }));
    const signed = preparedTransaction();
    signed.partialSign(OWNER);
    const outcome = await submitOpen(
      { simUrl: SIM_URL, owner: OWNER.publicKey.toBase58(), signedTx: signed },
      fetchFn as unknown as typeof fetch,
    );
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${SIM_URL}/v1/open/submit`);
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body).sort()).toEqual(["owner", "transaction"]);
    expect(body.owner).toBe(OWNER.publicKey.toBase58());
    expect(outcome).toEqual({ kind: "submitted", reference: "sig123" });
  });

  it("reads a request that got no answer as possibly open", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    });
    const outcome = await submitOpen(
      { simUrl: SIM_URL, owner: OWNER.publicKey.toBase58(), signedTx: preparedTransaction() },
      fetchFn as unknown as typeof fetch,
    );
    expect(outcome.kind).toBe("mayBeOpen");
  });
});

describe("refusal mapping", () => {
  it("maps an address not on the list to notInvited", async () => {
    const outcome = await refusedWith(
      403,
      "this address is not on the invite list. Ask for an invite, then try again",
      "prepare",
    );
    expect(outcome.kind).toBe("notInvited");
  });

  it("maps a code that does not match to inviteCodeWrong", async () => {
    const outcome = await refusedWith(
      403,
      "the invite code does not match this address. Check it and try again",
      "prepare",
    );
    expect(outcome.kind).toBe("inviteCodeWrong");
  });

  it("maps an address invited with a code, when none was sent, to inviteCodeNeeded", async () => {
    const outcome = await refusedWith(
      403,
      "this address is invited with a code. Send the invite code you were given",
      "prepare",
    );
    expect(outcome.kind).toBe("inviteCodeNeeded");
  });

  it("maps a used invite to inviteUsed", async () => {
    const outcome = await refusedWith(
      409,
      "this invite has been used already: it opens one account",
      "prepare",
    );
    expect(outcome.kind).toBe("inviteUsed");
  });

  it("maps an existing account to accountOpen", async () => {
    const outcome = await refusedWith(
      409,
      "this address has an account already. Nothing changed",
      "prepare",
    );
    expect(outcome.kind).toBe("accountOpen");
  });

  it("maps the program's account-exists refusal on submit to accountOpen", async () => {
    const outcome = await refusedWith(
      409,
      "the account was not opened: it exists already. Nothing changed",
      "submit",
    );
    expect(outcome.kind).toBe("accountOpen");
  });

  it("maps an unknown 409 to mayBeOpen", async () => {
    expect((await refusedWith(409, "Conflict", "submit")).kind).toBe("mayBeOpen");
  });

  it("maps a busy desk to tryLater", async () => {
    const outcome = await refusedWith(
      503,
      "the desk is busy with another request, try again",
      "prepare",
    );
    expect(outcome.kind).toBe("tryLater");
  });

  it.each([
    "today's new accounts are all given out: try again tomorrow, it resets at 00:00 UTC",
    "daily limit reached: no more new accounts can be opened today, try again tomorrow",
  ])("maps the day's limit %j to dailyCapReached on either step", async (reason) => {
    expect((await refusedWith(503, reason, "prepare")).kind).toBe("dailyCapReached");
    expect((await refusedWith(503, reason, "submit")).kind).toBe("dailyCapReached");
  });

  it.each([
    "this network address has opened its account for today: try again tomorrow, it resets at 00:00 UTC",
    "this network address has opened its account for today",
  ])("maps the per-address limit %j to addressLimit", async (reason) => {
    expect((await refusedWith(429, reason, "prepare")).kind).toBe("addressLimit");
  });

  it.each([
    "the service is still starting, try again in a few seconds",
    "the service is waking up, try again in a few seconds",
    "the rollup cannot be reached right now, try again",
    "the gate could not write its seat record, so it signed nothing. Nothing changed: try again, and tell the operator if it keeps happening",
  ])("maps the busy or starting reason %j to tryLater on submit", async (reason) => {
    expect((await refusedWith(503, reason, "submit")).kind).toBe("tryLater");
  });

  it("maps the gate's request throttle, with its seconds, to tryLater", async () => {
    const outcome = await refusedWith(
      429,
      "too many requests from this address: wait 12 s and try again",
      "prepare",
    );
    expect(outcome.kind).toBe("tryLater");
  });

  it("maps a short request throttle to tryLater, not the day's limit", async () => {
    const outcome = await refusedWith(429, "Rate limit exceeded, retry in 1 minute", "prepare");
    expect(outcome.kind).toBe("tryLater");
  });

  it("maps an expired prepare to prepareExpired", async () => {
    const outcome = await refusedWith(
      410,
      "nothing is prepared for this owner: prepare again",
      "submit",
    );
    expect(outcome.kind).toBe("prepareExpired");
  });

  it("maps an unconfirmed submit to mayBeOpen, never to a plain failure", async () => {
    const outcome = await refusedWith(
      502,
      "the rollup did not confirm in time. The account may have been opened: check before you try again",
      "submit",
    );
    expect(outcome.kind).toBe("mayBeOpen");
  });

  it("maps a submit 503 with an unknown text to mayBeOpen", async () => {
    expect((await refusedWith(503, "Service Unavailable", "submit")).kind).toBe("mayBeOpen");
  });

  it("maps a submit 503 with an empty body to mayBeOpen", async () => {
    const fetchFn = vi.fn(async () => new Response("", { status: 503 }));
    const outcome = await submitOpen(
      { simUrl: SIM_URL, owner: OWNER.publicKey.toBase58(), signedTx: preparedTransaction() },
      fetchFn as unknown as typeof fetch,
    );
    expect(outcome.kind).toBe("mayBeOpen");
  });

  it("maps a 500 from submit to mayBeOpen", async () => {
    expect((await refusedWith(500, "internal error", "submit")).kind).toBe("mayBeOpen");
  });

  it("maps a 504 from submit to mayBeOpen", async () => {
    expect((await refusedWith(504, "gateway timeout", "submit")).kind).toBe("mayBeOpen");
  });

  it("maps a 400 from submit to a clean rejection", async () => {
    expect(await refusedWith(400, "not the transaction that was prepared", "submit")).toEqual({
      kind: "rejected",
      status: 400,
    });
  });

  it("maps a 502 from prepare, where nothing was sent, to tryLater", async () => {
    const outcome = await refusedWith(502, "the rollup did not answer, try again", "prepare");
    expect(outcome.kind).toBe("tryLater");
  });

  it("never carries the invite code in a result or a thrown error", async () => {
    const echoing = vi.fn(async () => {
      throw new Error(`failed for ${INVITE}`);
    });
    const outcomes = await Promise.all([
      prepareOpen(
        { simUrl: SIM_URL, owner: OWNER.publicKey.toBase58(), orderKeys: [], invite: INVITE },
        echoing as unknown as typeof fetch,
      ),
      refusedWith(403, `the invite code ${INVITE} does not match`, "prepare"),
      refusedWith(409, `invite ${INVITE} has been used`, "prepare"),
    ]);
    expect(JSON.stringify(outcomes)).not.toContain(INVITE);
  });
});
