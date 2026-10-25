import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import { signedDiffers as check } from "@/lib/rollup/signedCheck";
import { keypairOwnerSigner } from "@/lib/wallet/ownerSigner";

const BLOCKHASH = "11111111111111111111111111111111";

/** The caller's order: the message is taken before the signer sees `built`. */
const signedDiffers = (built: Transaction, signed: Transaction, owner: Keypair["publicKey"]) =>
  check(built, built.serializeMessage(), signed, owner);

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
    expect(check(built, message, built, owner.publicKey)).not.toBeNull();
  });

  it("refuses a signed message that is not the one taken before signing", async () => {
    const owner = Keypair.generate();
    const built = build(owner);
    const message = built.serializeMessage();
    const altered = build(owner, 9_999);
    altered.partialSign(owner);
    expect(check(built, message, altered, owner.publicKey)).not.toBeNull();
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
