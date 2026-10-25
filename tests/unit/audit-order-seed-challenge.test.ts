import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { sha256 } from "@noble/hashes/sha256";
import { deriveOrderSeed } from "@/lib/rollup/keys";
import { freshOrderKeys, signInWithExpiry } from "@/lib/rollup/sdk";

/**
 * The rollup sign-in signs whatever challenge string the rollup endpoint
 * returns, with the owner key, and the order-key seed is a signature by the
 * same key over a fixed public string. An endpoint that answers the
 * challenge with that string receives the signature the seed is hashed from.
 */

const ORDER_SEED_DOMAIN = "noirwire-terminal/order-key-seed/v1";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("audit: rollup sign-in as a signing oracle for the order-key seed", () => {
  it("an endpoint choosing the challenge must not be able to recover the order seed", async () => {
    const owner = Keypair.generate();
    let signatureSentToEndpoint: Uint8Array | null = null;

    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/challenge")) return json({ challenge: ORDER_SEED_DOMAIN });
      if (url.includes("/auth/login")) return json({ token: "token" });
      throw new Error(`unexpected request ${url}`);
    });

    // The SDK posts exactly this signature (bs58-encoded) to /auth/login.
    const signMessage = async (message: Uint8Array) => {
      signatureSentToEndpoint = nacl.sign.detached(message, owner.secretKey);
      return signatureSentToEndpoint;
    };
    await signInWithExpiry("https://rollup.example", owner.publicKey, signMessage);

    expect(signatureSentToEndpoint).not.toBeNull();
    const recoveredSeed = sha256(signatureSentToEndpoint!);
    const realSeed = deriveOrderSeed(owner);

    const recoveredKeys = freshOrderKeys(recoveredSeed).publicKeys.map((k) => k.toBase58());
    const realKeys = freshOrderKeys(realSeed).publicKeys.map((k) => k.toBase58());

    expect(Buffer.from(recoveredSeed).equals(Buffer.from(realSeed))).toBe(false);
    expect(recoveredKeys).not.toEqual(realKeys);
  });
});
