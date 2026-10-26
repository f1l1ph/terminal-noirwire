import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, Message, SystemProgram, Transaction } from "@solana/web3.js";
import { signChecked, SignedTransactionRefused } from "@/lib/rollup/ownerSend";
import { keypairOwnerSigner, type OwnerSigner } from "@/lib/wallet/ownerSigner";

const BLOCKHASH = "11111111111111111111111111111111";
const LABEL = "wallet changed the transaction: capture";

function build(owner: Keypair) {
  return new Transaction({
    feePayer: owner.publicKey,
    blockhash: BLOCKHASH,
    lastValidBlockHeight: 1,
  }).add(
    SystemProgram.transfer({
      fromPubkey: owner.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1_000,
    }),
  );
}

/** A wallet that appends an instruction of its own before signing. */
function addingSigner(owner: Keypair): OwnerSigner {
  const honest = keypairOwnerSigner(owner);
  return {
    publicKey: owner.publicKey,
    signMessage: honest.signMessage,
    async signTransaction(tx) {
      const copy = Transaction.from(
        tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
      );
      copy.add(
        SystemProgram.transfer({
          fromPubkey: owner.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1,
        }),
      );
      copy.signatures = [];
      copy.partialSign(owner);
      return copy;
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("signChecked capture of a refused wallet change", () => {
  it("logs the refusal, chain, built and returned messages and the signers, without signatures, outside production, and still throws", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const owner = Keypair.generate();
    const built = build(owner);
    const builtMessage = built.serializeMessage();

    await expect(signChecked(addingSigner(owner), built, "solana:mainnet")).rejects.toBeInstanceOf(
      SignedTransactionRefused,
    );

    expect(info).toHaveBeenCalledTimes(1);
    const [label, capture] = info.mock.calls[0];
    expect(label).toBe(LABEL);
    expect(capture.reason).toContain("it added 1 instruction");
    expect(capture.chain).toBe("solana:mainnet");
    expect(capture.builtMessageBase64).toBe(Buffer.from(builtMessage).toString("base64"));
    const returned = Message.from(Buffer.from(capture.signedMessageBase64, "base64"));
    expect(returned.instructions).toHaveLength(2);
    expect(capture.signers).toEqual([{ publicKey: owner.publicKey.toBase58(), signed: true }]);
    expect(JSON.stringify(capture)).not.toContain("signature");
  });

  it("logs nothing in a production build, and still throws", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const owner = Keypair.generate();

    await expect(
      signChecked(addingSigner(owner), build(owner), "solana:mainnet"),
    ).rejects.toBeInstanceOf(SignedTransactionRefused);

    expect(info).not.toHaveBeenCalled();
  });

  it("logs nothing when the wallet returns the transaction it was given", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const owner = Keypair.generate();

    await signChecked(keypairOwnerSigner(owner), build(owner));

    expect(info).not.toHaveBeenCalled();
  });
});
