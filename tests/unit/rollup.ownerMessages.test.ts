import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, Transaction, type Connection } from "@solana/web3.js";
import nacl from "tweetnacl";
import { ownerActionSpecEnvelope } from "@noirwire/orderbook";
import {
  installOrderKeysSigned,
  messageDeclined,
  OwnerActionFailed,
  OwnerActionRefused,
  signOwnerAction,
} from "@/lib/rollup/ownerMessages";
import { freshOrderKeys, ownerActionText, PACKAGE_PROGRAM_ID, type View } from "@/lib/rollup/sdk";
import { keypairOwnerSigner, type OwnerSigner } from "@/lib/wallet/ownerSigner";

const views: Array<Pick<View, "orderKeys" | "ownerNonce">> = [];
const CLOCK = 1_800_000_000;

vi.mock("@/lib/rollup/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rollup/sdk")>();
  class ScriptedClient {
    async view() {
      const next = views.length > 1 ? views.shift() : views[0];
      return next as View;
    }
  }
  return {
    ...actual,
    TraderClient: ScriptedClient,
    rollupClockSeconds: async () => CLOCK,
  };
});

const OWNER = Keypair.generate();
const KEYS = freshOrderKeys(new Uint8Array(32).fill(7));
const OTHER_KEYS = Array.from({ length: 4 }, () => Keypair.generate().publicKey);
const BLOCKHASH = "11111111111111111111111111111111";

function wallet(sign?: OwnerSigner["signMessage"]) {
  const real = keypairOwnerSigner(OWNER);
  const signMessage = vi.fn(sign ?? real.signMessage);
  const signTransaction = vi.fn(real.signTransaction);
  const signer: OwnerSigner = { publicKey: OWNER.publicKey, signMessage, signTransaction };
  return { signer, signMessage, signTransaction };
}

/** A rollup that answers each send with the next scripted status: success, or a failure with the program's error number. */
function rollup(statuses: Array<null | number>) {
  const sent: Uint8Array[] = [];
  const connection = {
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 10 }),
    sendRawTransaction: async (raw: Uint8Array) => {
      sent.push(raw);
      return `signature-${sent.length}`;
    },
    getSignatureStatus: async () => {
      const code = statuses[Math.min(sent.length, statuses.length) - 1];
      return {
        value: {
          confirmationStatus: "confirmed",
          err: code === null ? null : { InstructionError: [1, { Custom: code }] },
        },
      };
    },
  } as unknown as Connection;
  return { connection, sent };
}

const timing = { now: () => 0, sleep: async () => {} };
const ours = { orderKeys: KEYS.publicKeys, ownerNonce: 4 };
const theirs = { orderKeys: OTHER_KEYS, ownerNonce: 3 };

beforeEach(() => {
  views.length = 0;
});

describe("the owner action message", () => {
  const owner = new PublicKey(new Uint8Array(32).fill(1));
  const keys = [2, 3, 4, 5].map((byte) => new PublicKey(new Uint8Array(32).fill(byte)));
  const digest = (action: "open" | "replace", nonce?: number) =>
    createHash("sha256")
      .update(ownerActionText(action, PACKAGE_PROGRAM_ID, owner, keys, 1_800_000_000n, nonce))
      .digest("hex");

  it("matches the program's owner action message vectors", () => {
    expect(digest("open")).toBe("78b22efd8b43797377c045292134f6706b22b76dd99ef92a09b6b6dfb5a6aaf6");
    expect(digest("replace", 0xffffffff)).toBe(
      "4a73fa6da661e1f231533a4431b87bdef8f0dbbef84658b5fe2013ad8b652511",
    );
  });
});

describe("signOwnerAction", () => {
  const expected = {
    action: "open" as const,
    programId: PACKAGE_PROGRAM_ID,
    keys: KEYS.publicKeys,
    expiresAt: 1_800_000_100n,
  };
  const message = () =>
    ownerActionText("open", PACKAGE_PROGRAM_ID, OWNER.publicKey, KEYS.publicKeys, 1_800_000_100n);

  it("returns the wallet's verified 64-byte signature", async () => {
    const { signer, signMessage } = wallet();
    const { signature, form } = await signOwnerAction(signer, message(), expected);
    expect(signature).toHaveLength(64);
    expect(form).toBe("raw");
    expect(signMessage).toHaveBeenCalledTimes(1);
    expect(nacl.sign.detached.verify(message(), signature, OWNER.publicKey.toBytes())).toBe(true);
  });

  it("accepts a signature over the specification header naming the program, and says so", async () => {
    const signed = (programId: PublicKey) =>
      wallet(async (bytes) =>
        nacl.sign.detached(
          ownerActionSpecEnvelope(bytes, { programId, owner: OWNER.publicKey }),
          OWNER.secretKey,
        ),
      );
    const { signer } = signed(PACKAGE_PROGRAM_ID);
    const { form } = await signOwnerAction(signer, message(), expected);
    expect(form).toBe("spec");
  });

  it("refuses a specification header that names another program", async () => {
    const { signer } = wallet(async (bytes) =>
      nacl.sign.detached(
        ownerActionSpecEnvelope(bytes, {
          programId: Keypair.generate().publicKey,
          owner: OWNER.publicKey,
        }),
        OWNER.secretKey,
      ),
    );
    await expect(signOwnerAction(signer, message(), expected)).rejects.toThrow(/does not match/);
  });

  it("refuses bytes that are not the expected message, before the wallet is asked", async () => {
    const { signer, signMessage } = wallet();
    const other = ownerActionText(
      "open",
      PACKAGE_PROGRAM_ID,
      OWNER.publicKey,
      OTHER_KEYS,
      1_800_000_100n,
    );
    await expect(signOwnerAction(signer, other, expected)).rejects.toBeInstanceOf(
      OwnerActionRefused,
    );
    await expect(
      signOwnerAction(signer, message(), { ...expected, expiresAt: 1_800_000_101n }),
    ).rejects.toBeInstanceOf(OwnerActionRefused);
    expect(signMessage).not.toHaveBeenCalled();
  });

  it("refuses a signature that does not verify and one of the wrong length", async () => {
    const forged = wallet(async (bytes) => nacl.sign.detached(bytes, Keypair.generate().secretKey));
    await expect(signOwnerAction(forged.signer, message(), expected)).rejects.toThrow(
      /does not match/,
    );
    const short = wallet(async () => new Uint8Array(10));
    await expect(signOwnerAction(short.signer, message(), expected)).rejects.toThrow(
      /did not return a signature/,
    );
  });

  it("lets the wallet's own refusal through, and knows it for a decline", async () => {
    const declined = wallet(async () => {
      throw new Error("User rejected the request");
    });
    const error = await signOwnerAction(declined.signer, message(), expected).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).not.toBeInstanceOf(OwnerActionRefused);
    expect(messageDeclined(error)).toBe(true);
    expect(messageDeclined(new OwnerActionRefused("the signature is wrong"))).toBe(false);
  });
});

describe("installOrderKeysSigned", () => {
  const install = (w: ReturnType<typeof wallet>, r: ReturnType<typeof rollup>) =>
    installOrderKeysSigned(r.connection, w.signer, KEYS, PACKAGE_PROGRAM_ID, timing);

  it("signs the replace message for the view's nonce, sends it with a throwaway payer and never asks the wallet for a transaction", async () => {
    const w = wallet();
    const r = rollup([null]);
    views.push(theirs, ours);
    await install(w, r);
    expect(w.signMessage).toHaveBeenCalledTimes(1);
    expect(w.signTransaction).not.toHaveBeenCalled();
    expect(w.signMessage.mock.calls[0][0]).toEqual(
      ownerActionText(
        "replace",
        PACKAGE_PROGRAM_ID,
        OWNER.publicKey,
        KEYS.publicKeys,
        BigInt(CLOCK + 100),
        3,
      ),
    );
    expect(r.sent).toHaveLength(1);
    const transaction = Transaction.from(r.sent[0]);
    expect(transaction.instructions).toHaveLength(2);
    expect(transaction.feePayer?.equals(OWNER.publicKey)).toBe(false);
    expect(transaction.signatures.map((entry) => entry.publicKey.toBase58())).toEqual([
      transaction.feePayer?.toBase58(),
    ]);
  });

  it("sends nothing when the view already holds these keys", async () => {
    const w = wallet();
    const r = rollup([null]);
    views.push(ours);
    await install(w, r);
    expect(w.signMessage).not.toHaveBeenCalled();
    expect(r.sent).toHaveLength(0);
  });

  it("takes a wrong nonce as success when the view then shows these keys", async () => {
    const w = wallet();
    const r = rollup([6152]);
    views.push(theirs, ours);
    await install(w, r);
    expect(r.sent).toHaveLength(1);
  });

  it("signs once more for the new nonce after a wrong nonce, and succeeds", async () => {
    const w = wallet();
    const r = rollup([6152, null]);
    views.push(
      theirs,
      { orderKeys: OTHER_KEYS, ownerNonce: 5 },
      { orderKeys: OTHER_KEYS, ownerNonce: 5 },
      ours,
    );
    await install(w, r);
    expect(r.sent).toHaveLength(2);
    expect(w.signMessage).toHaveBeenCalledTimes(2);
    expect(w.signMessage.mock.calls[1][0]).toEqual(
      ownerActionText(
        "replace",
        PACKAGE_PROGRAM_ID,
        OWNER.publicKey,
        KEYS.publicKeys,
        BigInt(CLOCK + 100),
        5,
      ),
    );
  });

  it("says another device changed the account after a second wrong nonce", async () => {
    const w = wallet();
    const r = rollup([6152, 6152]);
    views.push({ orderKeys: OTHER_KEYS, ownerNonce: 3 });
    const error = await install(w, r).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(OwnerActionFailed);
    expect((error as Error).message).toBe(
      "Your account changed on another device. Reload and try again.",
    );
    expect(r.sent).toHaveLength(2);
  });

  it.each([
    [6151, /signature did not match/],
    [6153, /wrong time/],
    [6133, /took too long/],
  ])("words program error %i in plain language", async (code, text) => {
    const w = wallet();
    const r = rollup([code]);
    views.push(theirs);
    const error = await install(w, r).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(OwnerActionFailed);
    expect((error as Error).message).toMatch(text);
  });

  it("sends nothing when the wallet declines the message", async () => {
    const w = wallet(async () => {
      throw new Error("User rejected the request");
    });
    const r = rollup([null]);
    views.push(theirs);
    await expect(install(w, r)).rejects.toThrow(/rejected/);
    expect(r.sent).toHaveLength(0);
    expect(w.signTransaction).not.toHaveBeenCalled();
  });
});
