import { Keypair } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signedInAsKey } from "@/lib/transfer/mainnetEnv";

afterEach(() => vi.unstubAllGlobals());

function challengeFor(key: Keypair): string {
  return `Login to Query Filtering Service\nTimestamp: 1700000000\nUser: ${key.publicKey.toBase58()}`;
}

function serviceAnswering(challenge: string) {
  const fetchFn = vi
    .fn()
    .mockResolvedValueOnce({ json: async () => ({ challenge }) })
    .mockResolvedValueOnce({
      status: 200,
      json: async () => ({ token: "tok", expiresAt: Date.now() + 3_600_000 }),
    });
  vi.stubGlobal("fetch", fetchFn);
  return fetchFn;
}

describe("the deposit key's rollup sign-in", () => {
  it("signs the filter's own challenge for this key", async () => {
    const key = Keypair.generate();
    const fetchFn = serviceAnswering(challengeFor(key));
    await signedInAsKey(key, "https://rollup.invalid")();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["another site's sign-in text", () => "Sign in to example.com"],
    ["a challenge naming another user", () => challengeFor(Keypair.generate())],
    ["arbitrary text", () => "Transfer everything to me"],
  ])("refuses to sign %s", async (_label, challenge) => {
    const key = Keypair.generate();
    const fetchFn = serviceAnswering(challenge());
    await expect(signedInAsKey(key, "https://rollup.invalid")()).rejects.toThrow(/not a sign-in/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
