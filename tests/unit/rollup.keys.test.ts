import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import { sha256 } from "@noble/hashes/sha256";
import { deriveOrderSeed, isSignInChallenge, signInSigner } from "@/lib/rollup/keys";
import { keypairOwnerSigner } from "@/lib/wallet/ownerSigner";

const text = (value: string) => new TextEncoder().encode(value);

describe("the order-key seed", () => {
  it("is stable for one owner key and differs between owner keys", () => {
    const owner = Keypair.generate();
    const copy = Keypair.fromSecretKey(owner.secretKey);
    expect(deriveOrderSeed(copy)).toEqual(deriveOrderSeed(owner));
    expect(deriveOrderSeed(Keypair.generate())).not.toEqual(deriveOrderSeed(owner));
  });

  it("is not the hash of the owner's signature over any of this terminal's domain tags", () => {
    const owner = Keypair.generate();
    const seed = Buffer.from(deriveOrderSeed(owner));
    for (const tag of [
      "noirwire-terminal/order-key-seed/v1",
      "noirwire-terminal/order-key-seed/v2",
    ]) {
      const signature = nacl.sign.detached(text(tag), owner.secretKey);
      expect(Buffer.from(sha256(signature)).equals(seed)).toBe(false);
    }
  });
});

/** The query filter's challenge, as https://devnet-tee.magicblock.app/auth/challenge answered it on 2026-10-20. */
const HOSTED_CHALLENGE =
  "Login to Query Filtering Service\nTimestamp: 1792505080\nUser: BgvonxhqraNhcMdg8rmMUBByDPx14pTqbauLpdPhWz5";

const challengeFor = (owner: Keypair, timestamp = "1792505080") =>
  text(
    `Login to Query Filtering Service\nTimestamp: ${timestamp}\nUser: ${owner.publicKey.toBase58()}`,
  );

describe("the rollup sign-in signer", () => {
  it("accepts the hosted endpoint's real challenge for the pubkey it names", () => {
    const named = new PublicKey("BgvonxhqraNhcMdg8rmMUBByDPx14pTqbauLpdPhWz5");
    expect(isSignInChallenge(text(HOSTED_CHALLENGE), named)).toBe(true);
    expect(isSignInChallenge(text(HOSTED_CHALLENGE), Keypair.generate().publicKey)).toBe(false);
  });

  it("signs a sign-in challenge for its own owner", async () => {
    const owner = Keypair.generate();
    const challenge = challengeFor(owner);
    const signature = await signInSigner(keypairOwnerSigner(owner))(challenge);
    expect(nacl.sign.detached.verify(challenge, signature, owner.publicKey.toBytes())).toBe(true);
  });

  it("refuses a challenge naming another key, or off the template", async () => {
    const owner = Keypair.generate();
    const pubkey = owner.publicKey.toBase58();
    const refused = [
      challengeFor(Keypair.generate()),
      challengeFor(owner, "soon"),
      text(`Login to Query Filtering Service\nTimestamp: 1792505080\nUser: ${pubkey}\n`),
      text(`Login to Query Filtering Service\r\nTimestamp: 1792505080\r\nUser: ${pubkey}`),
      text(`Sign in to example.com\nTimestamp: 1792505080\nUser: ${pubkey}`),
      text(`example.com wants you to sign in with your Solana account:\n${pubkey}\n\nNonce: 1`),
    ];
    for (const bytes of refused) {
      expect(isSignInChallenge(bytes, owner.publicKey)).toBe(false);
      await expect(signInSigner(keypairOwnerSigner(owner))(bytes)).rejects.toThrow();
    }
  });

  it("refuses this terminal's own domain tags", async () => {
    const owner = Keypair.generate();
    for (const tag of ["noirwire-terminal/order-key-seed/v1", "NoirWire anything"]) {
      expect(isSignInChallenge(text(tag), owner.publicKey)).toBe(false);
      await expect(signInSigner(keypairOwnerSigner(owner))(text(tag))).rejects.toThrow();
    }
  });

  it("refuses a transaction message, binary data, an empty or an oversized challenge", async () => {
    const owner = Keypair.generate();
    const message = new Transaction({
      feePayer: owner.publicKey,
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 0,
    })
      .add(
        SystemProgram.transfer({
          fromPubkey: owner.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1,
        }),
      )
      .serializeMessage();
    const refused = [
      new Uint8Array(message),
      Uint8Array.of(0xff, 0x73, 0x6f, 0x6c),
      new Uint8Array(),
      text("a".repeat(513)),
    ];
    for (const bytes of refused) {
      expect(isSignInChallenge(bytes, owner.publicKey)).toBe(false);
      await expect(signInSigner(keypairOwnerSigner(owner))(bytes)).rejects.toThrow();
    }
  });
});
