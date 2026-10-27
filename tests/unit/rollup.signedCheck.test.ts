import { describe, expect, it } from "vitest";
import {
  Keypair,
  Message,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import { WALLET_ASSERTION_PROGRAM, signedDiffers as check } from "@/lib/rollup/signedCheck";
import { keypairOwnerSigner } from "@/lib/wallet/ownerSigner";

const BLOCKHASH = "11111111111111111111111111111111";

/** The caller's order: the message is taken before the signer sees `built`. */
const signedDiffers = (
  built: Transaction,
  signed: Transaction,
  owner: Keypair["publicKey"],
  allowWalletAssertions = false,
) => check(built, built.serializeMessage(), signed, owner, allowWalletAssertions);

function build(owner: Keypair, lamports = 1_000) {
  const tx = new Transaction({
    feePayer: owner.publicKey,
    blockhash: BLOCKHASH,
    lastValidBlockHeight: 1,
  });
  tx.add(
    SystemProgram.transfer({
      fromPubkey: owner.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports,
    }),
  );
  return tx;
}

describe("signedDiffers", () => {
  it("accepts the built transaction signed by the owner", async () => {
    const owner = Keypair.generate();
    const built = build(owner);
    const signed = await keypairOwnerSigner(owner).signTransaction(built);
    expect(signedDiffers(built, signed, owner.publicKey)).toBeNull();
  });

  it("refuses the very object it was given, even when it was changed in place", async () => {
    const owner = Keypair.generate();
    const built = build(owner);
    const message = built.serializeMessage();
    built.instructions[0] = build(owner, 9_999).instructions[0];
    built.partialSign(owner);
    expect(check(built, message, built, owner.publicKey, true)).not.toBeNull();
  });

  it("refuses a signed message that is not the one taken before signing", async () => {
    const owner = Keypair.generate();
    const built = build(owner);
    const message = built.serializeMessage();
    const altered = build(owner, 9_999);
    altered.partialSign(owner);
    expect(check(built, message, altered, owner.publicKey, true)).not.toBeNull();
  });

  it("refuses a message that differs in one byte", async () => {
    const owner = Keypair.generate();
    const built = build(owner);
    const signed = await keypairOwnerSigner(owner).signTransaction(build(owner, 1_001));
    expect(signedDiffers(built, signed, owner.publicKey)).not.toBeNull();
  });

  it("refuses an instruction the signer added", async () => {
    const owner = Keypair.generate();
    const built = build(owner);
    const longer = build(owner);
    longer.add(
      SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    );
    const signed = await keypairOwnerSigner(owner).signTransaction(longer);
    expect(signedDiffers(built, signed, owner.publicKey)).not.toBeNull();
  });

  it("refuses a changed fee payer", async () => {
    const owner = Keypair.generate();
    const other = Keypair.generate();
    const built = build(owner);
    const swapped = Transaction.from(
      built.serialize({ requireAllSignatures: false, verifySignatures: false }),
    );
    swapped.feePayer = other.publicKey;
    swapped.partialSign(owner);
    expect(signedDiffers(built, swapped, owner.publicKey)).not.toBeNull();
  });

  it("refuses an owner signature that does not verify", async () => {
    const owner = Keypair.generate();
    const built = build(owner);
    const signed = Transaction.from(
      built.serialize({ requireAllSignatures: false, verifySignatures: false }),
    );
    signed.addSignature(
      owner.publicKey,
      Buffer.from(nacl.sign.detached(new Uint8Array([1, 2, 3]), owner.secretKey)),
    );
    expect(signedDiffers(built, signed, owner.publicKey)).not.toBeNull();
  });

  it("refuses an owner signature that is missing", () => {
    const owner = Keypair.generate();
    const built = build(owner);
    const unsigned = Transaction.from(
      built.serialize({ requireAllSignatures: false, verifySignatures: false }),
    );
    expect(signedDiffers(built, unsigned, owner.publicKey)).not.toBeNull();
  });

  it("refuses a signature from a signer the built transaction did not carry", async () => {
    const owner = Keypair.generate();
    const extra = Keypair.generate();
    const withExtra = () => {
      const tx = new Transaction({
        feePayer: owner.publicKey,
        blockhash: BLOCKHASH,
        lastValidBlockHeight: 1,
      });
      tx.add(
        SystemProgram.transfer({
          fromPubkey: extra.publicKey,
          toPubkey: owner.publicKey,
          lamports: 1,
        }),
      );
      return tx;
    };
    const built = withExtra();
    const signed = await keypairOwnerSigner(owner).signTransaction(built);
    signed.partialSign(extra);
    expect(signedDiffers(built, signed, owner.publicKey)).not.toBeNull();
  });

  it.each([
    [
      "stripped",
      (signed: Transaction, extra: Keypair) => {
        signed.signatures.find((e) => e.publicKey.equals(extra.publicKey))!.signature = null;
      },
    ],
    [
      "changed",
      (signed: Transaction, extra: Keypair) => {
        signed.signatures.find((e) => e.publicKey.equals(extra.publicKey))!.signature =
          Buffer.alloc(64, 7);
      },
    ],
  ])("refuses a co-signature the built transaction carried that was %s", async (_name, tamper) => {
    const owner = Keypair.generate();
    const extra = Keypair.generate();
    const built = new Transaction({
      feePayer: owner.publicKey,
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 1,
    });
    built.add(
      SystemProgram.transfer({
        fromPubkey: extra.publicKey,
        toPubkey: owner.publicKey,
        lamports: 1,
      }),
    );
    built.partialSign(extra);
    const signed = await keypairOwnerSigner(owner).signTransaction(built);
    tamper(signed, extra);
    expect(signedDiffers(built, signed, owner.publicKey)).not.toBeNull();
  });

  it("accepts a co-signature the built transaction already carried", async () => {
    const owner = Keypair.generate();
    const extra = Keypair.generate();
    const built = new Transaction({
      feePayer: owner.publicKey,
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 1,
    });
    built.add(
      SystemProgram.transfer({
        fromPubkey: extra.publicKey,
        toPubkey: owner.publicKey,
        lamports: 1,
      }),
    );
    built.partialSign(extra);
    const signed = await keypairOwnerSigner(owner).signTransaction(built);
    expect(signedDiffers(built, signed, owner.publicKey)).toBeNull();
  });
});

describe("signedDiffers on a transaction the fee payer signed first", () => {
  const BUDGET = "ComputeBudget111111111111111111111111111111";

  function gateSigned(gate: Keypair, owner: Keypair) {
    const built = new Transaction({
      feePayer: gate.publicKey,
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 1,
    });
    built.add(
      SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 5,
      }),
    );
    built.partialSign(gate);
    return built;
  }

  const cloneOf = (transaction: Transaction) =>
    Transaction.from(
      transaction.serialize({ requireAllSignatures: false, verifySignatures: false }),
    );

  it("accepts a wallet that only added the owner's signature and kept the gate's", async () => {
    const gate = Keypair.generate();
    const owner = Keypair.generate();
    const built = gateSigned(gate, owner);
    const signed = await keypairOwnerSigner(owner).signTransaction(built);
    expect(signedDiffers(built, signed, owner.publicKey)).toBeNull();
  });

  it("refuses instructions the wallet added and names their programs", async () => {
    const gate = Keypair.generate();
    const owner = Keypair.generate();
    const built = gateSigned(gate, owner);
    const widened = cloneOf(built);
    for (const data of [
      [2, 1],
      [3, 2],
    ]) {
      widened.add(
        new TransactionInstruction({
          programId: new PublicKey(BUDGET),
          keys: [],
          data: Buffer.from(data),
        }),
      );
    }
    const signed = await keypairOwnerSigner(owner).signTransaction(widened);
    expect(signedDiffers(built, signed, owner.publicKey)).toBe(
      `your wallet changed the transaction (it added 2 instructions, from programs ${BUDGET})`,
    );
  });

  it("refuses a dropped gate signature and says so", async () => {
    const gate = Keypair.generate();
    const owner = Keypair.generate();
    const built = gateSigned(gate, owner);
    const signed = await keypairOwnerSigner(owner).signTransaction(cloneOf(built));
    signed.signatures.find((entry) => entry.publicKey.equals(gate.publicKey))!.signature = null;
    expect(signedDiffers(built, signed, owner.publicKey)).toBe(
      `your wallet removed or changed the signature already on the transaction from ${gate.publicKey.toBase58()}`,
    );
  });

  it("refuses an altered gate signature", async () => {
    const gate = Keypair.generate();
    const owner = Keypair.generate();
    const built = gateSigned(gate, owner);
    const signed = await keypairOwnerSigner(owner).signTransaction(cloneOf(built));
    signed.signatures.find((entry) => entry.publicKey.equals(gate.publicKey))!.signature =
      Buffer.alloc(64, 3);
    expect(signedDiffers(built, signed, owner.publicKey)).toContain("removed or changed");
  });

  it("names a changed blockhash and a changed fee payer", async () => {
    const gate = Keypair.generate();
    const owner = Keypair.generate();
    const built = gateSigned(gate, owner);
    const rehashed = cloneOf(built);
    rehashed.recentBlockhash = Keypair.generate().publicKey.toBase58();
    const signedRehashed = await keypairOwnerSigner(owner).signTransaction(rehashed);
    expect(signedDiffers(built, signedRehashed, owner.publicKey)).toBe(
      "your wallet changed the transaction (it changed the recent blockhash)",
    );
    const repaid = new Transaction({
      feePayer: owner.publicKey,
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 1,
    }).add(...built.instructions);
    const signedRepaid = await keypairOwnerSigner(owner).signTransaction(repaid);
    expect(signedDiffers(built, signedRepaid, owner.publicKey)).toBe(
      "your wallet changed the transaction (it changed the fee payer)",
    );
  });
});

describe("signedDiffers on a wallet that appends its assertions", () => {
  const assertion = (keys: TransactionInstruction["keys"] = []) =>
    new TransactionInstruction({
      programId: new PublicKey(WALLET_ASSERTION_PROGRAM),
      keys,
      data: Buffer.from([7, 7, 7]),
    });
  const readOnly = () => ({
    pubkey: Keypair.generate().publicKey,
    isSigner: false,
    isWritable: false,
  });
  const pay = (from: Keypair, to: Keypair["publicKey"], lamports: number) =>
    SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports });

  /** The deposit key pays the second instruction, as in a deposit: the owner and the key both sign. */
  function world() {
    const owner = Keypair.generate();
    const key = Keypair.generate();
    const target = Keypair.generate().publicKey;
    const ours = [pay(owner, target, 1_000), pay(key, target, 2_000)];
    const make = (instructions: TransactionInstruction[], blockhash = BLOCKHASH) =>
      new Transaction({ feePayer: owner.publicKey, blockhash, lastValidBlockHeight: 1 }).add(
        ...instructions,
      );
    /** What a wallet hands back: the message it was given, re-made with `instructions`, signed by the owner alone and decoded again. */
    const walletSigns = (instructions: TransactionInstruction[], blockhash = BLOCKHASH) => {
      const tx = make(instructions, blockhash);
      tx.partialSign(owner);
      return Transaction.from(tx.serialize({ requireAllSignatures: false }));
    };
    return { owner, key, target, ours, built: make(ours), make, walletSigns };
  }

  it("accepts assertions appended after our instructions on a mainnet send", () => {
    const w = world();
    const signed = w.walletSigns([...w.ours, assertion([readOnly()]), assertion([readOnly()])]);
    expect(signedDiffers(w.built, signed, w.owner.publicKey, true)).toBeNull();
  });

  it("accepts assertions placed before and between our instructions, our order kept", () => {
    const w = world();
    const signed = w.walletSigns([
      assertion([readOnly()]),
      w.ours[0],
      assertion([readOnly()]),
      w.ours[1],
      assertion(),
    ]);
    expect(signedDiffers(w.built, signed, w.owner.publicKey, true)).toBeNull();
  });

  it("refuses the same assertions on a rollup send, with today's message", () => {
    const w = world();
    const signed = w.walletSigns([...w.ours, assertion([readOnly()])]);
    expect(signedDiffers(w.built, signed, w.owner.publicKey, false)).toBe(
      `your wallet changed the transaction (it added 1 instruction, from programs ${WALLET_ASSERTION_PROGRAM})`,
    );
  });

  it("refuses an addition from any other program", () => {
    const w = world();
    const other = new TransactionInstruction({
      programId: Keypair.generate().publicKey,
      keys: [readOnly()],
      data: Buffer.from([1]),
    });
    const signed = w.walletSigns([...w.ours, assertion(), other]);
    expect(signedDiffers(w.built, signed, w.owner.publicKey, true)).toContain(
      "your wallet changed the transaction (it added 2 instructions",
    );
  });

  it("refuses an added instruction that marks a new account as a signer", () => {
    const w = world();
    const intruder = Keypair.generate();
    const signed = w.walletSigns([
      ...w.ours,
      assertion([{ pubkey: intruder.publicKey, isSigner: true, isWritable: false }]),
    ]);
    expect(signedDiffers(w.built, signed, w.owner.publicKey, true)).toContain(
      "your wallet changed the transaction",
    );
  });

  it("accepts assertions that name the owner, the deposit key and the owner's token account, as a wallet's output decoded from the wire", () => {
    const w = world();
    const tokenAccount = Keypair.generate().publicKey;
    const widened = Transaction.populate(Message.from(w.built.serializeMessage()));
    widened.add(
      assertion([
        { pubkey: w.owner.publicKey, isSigner: false, isWritable: false },
        { pubkey: w.key.publicKey, isSigner: false, isWritable: false },
        { pubkey: tokenAccount, isSigner: false, isWritable: false },
      ]),
      assertion([{ pubkey: w.owner.publicKey, isSigner: false, isWritable: true }]),
    );
    widened.partialSign(w.owner);
    const signed = Transaction.from(widened.serialize({ requireAllSignatures: false }));
    const owner = signed.instructions.at(-1)!.keys[0];
    expect(owner.isSigner && owner.isWritable).toBe(true);
    expect(signedDiffers(w.built, signed, w.owner.publicKey, true)).toBeNull();
  });

  it("accepts an introduced account that is writable but not a signer", () => {
    const w = world();
    const signed = w.walletSigns([
      ...w.ours,
      assertion([{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }]),
    ]);
    expect(signedDiffers(w.built, signed, w.owner.publicKey, true)).toBeNull();
  });

  it("refuses a readonly account of ours made writable", () => {
    const w = world();
    const signed = w.walletSigns([
      ...w.ours,
      assertion([{ pubkey: SystemProgram.programId, isSigner: false, isWritable: true }]),
    ]);
    expect(signedDiffers(w.built, signed, w.owner.publicKey, true)).toContain(
      "your wallet changed the transaction",
    );
  });

  it("refuses a non-signer account of ours made a signer", () => {
    const w = world();
    const signed = w.walletSigns([
      ...w.ours,
      assertion([{ pubkey: w.target, isSigner: true, isWritable: true }]),
    ]);
    expect(signedDiffers(w.built, signed, w.owner.publicKey, true)).toContain(
      "your wallet changed the transaction",
    );
  });

  it("refuses a changed number of required signatures", () => {
    const w = world();
    const widened = Transaction.populate(Message.from(w.built.serializeMessage()));
    widened.add(assertion());
    const message = widened.compileMessage();
    message.header.numRequiredSignatures += 1;
    message.header.numReadonlySignedAccounts += 1;
    const wire = Buffer.concat([
      Buffer.from([message.header.numRequiredSignatures]),
      Buffer.alloc(64 * message.header.numRequiredSignatures),
      message.serialize(),
    ]);
    expect(signedDiffers(w.built, Transaction.from(wire), w.owner.publicKey, true)).toContain(
      "your wallet changed the transaction",
    );
  });

  it("refuses when one of our instructions is altered", () => {
    const w = world();
    const signed = w.walletSigns([pay(w.owner, w.target, 1_001), w.ours[1], assertion()]);
    expect(signedDiffers(w.built, signed, w.owner.publicKey, true)).toContain(
      "your wallet changed the transaction",
    );
  });

  it("refuses when our instructions are reordered", () => {
    const w = world();
    const signed = w.walletSigns([w.ours[1], w.ours[0], assertion()]);
    expect(signedDiffers(w.built, signed, w.owner.publicKey, true)).toContain(
      "your wallet changed the transaction",
    );
  });

  it("refuses when one of our instructions is missing", () => {
    const w = world();
    const signed = w.walletSigns([w.ours[0], assertion()]);
    expect(signedDiffers(w.built, signed, w.owner.publicKey, true)).toContain(
      "your wallet changed the transaction",
    );
  });

  it("refuses a changed blockhash or fee payer even with only assertions added", () => {
    const w = world();
    const rehashed = w.walletSigns(
      [...w.ours, assertion()],
      Keypair.generate().publicKey.toBase58(),
    );
    expect(signedDiffers(w.built, rehashed, w.owner.publicKey, true)).toBe(
      "your wallet changed the transaction (it changed the recent blockhash)",
    );
    const other = Keypair.generate();
    const repaid = new Transaction({
      feePayer: other.publicKey,
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 1,
    }).add(...w.ours, assertion());
    repaid.partialSign(other);
    expect(signedDiffers(w.built, repaid, w.owner.publicKey, true)).toBe(
      "your wallet changed the transaction (it changed the fee payer)",
    );
  });

  it("refuses when the required signers change", () => {
    const w = world();
    const extra = Keypair.generate();
    const signed = w.walletSigns([...w.ours, pay(extra, w.target, 1)]);
    expect(signedDiffers(w.built, signed, w.owner.publicKey, true)).toContain(
      "your wallet changed the transaction",
    );
  });
});
