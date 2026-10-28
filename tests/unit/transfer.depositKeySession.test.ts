import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { describe, expect, it, vi } from "vitest";

const signIn = vi.fn(async () => ({ token: "tok", expiresAtMs: Date.now() + 1e7 }));
const connect = vi.fn(() => ({ marker: "key-session" }));

vi.mock("@/lib/rollup/sdk", async (original) => ({
  ...(await original<typeof import("@/lib/rollup/sdk")>()),
  signInWithExpiry: signIn,
  connectWithToken: connect,
}));

const { rollupBaseUrl, createMainnetTransferEnv } = await import("@/lib/transfer/mainnetEnv");
const { mainnetOwnerSigner } = await import("@/lib/rollup/mainnetOwner");
const { keypairOwnerSigner } = await import("@/lib/wallet/ownerSigner");
const { MAINNET_PINS } = await import("@/lib/rollup/pins");
const { PublicKey } = await import("@solana/web3.js");

describe("the rollup address the deposit key signs in at", () => {
  it("is the session's, without its token or a trailing slash", () => {
    expect(rollupBaseUrl("https://rollup.example/base/?token=abc")).toBe(
      "https://rollup.example/base",
    );
    expect(rollupBaseUrl("https://rollup.example?token=abc")).toBe("https://rollup.example");
  });

  it("is used for the key's sign-in, signed by the key and nobody else, once", async () => {
    const owner = Keypair.generate();
    const guarded = mainnetOwnerSigner(keypairOwnerSigner(owner), "https://rpc.invalid", {
      solana: { getGenesisHash: async () => MAINNET_PINS.solanaGenesis },
      rollupIdentity: async () => MAINNET_PINS.validator,
    });
    const key = Keypair.generate();
    const mint = new PublicKey(MAINNET_PINS.usdcMint);
    const env = await createMainnetTransferEnv({
      signer: guarded,
      solana: {} as never,
      rollup: {} as never,
      rollupEndpoint: "https://session.example/rollup?token=secret",
      depositKey: key,
      accountOpen: async () => true,
      confirmSeat: async () => true,
      readExchange: async () => ({
        paused: false,
        minSeatDeposit: 0n,
        sealed: false,
        token: { mint, custodyNonce: 7n },
        perpMarketIds: [],
      }),
      journal: {} as never,
    });
    await env.depositRollup();
    await env.depositRollup();
    expect(signIn).toHaveBeenCalledTimes(1);
    const [url, reader, signMessage] = signIn.mock.calls[0] as unknown as [
      string,
      InstanceType<typeof PublicKey>,
      (message: Uint8Array) => Promise<Uint8Array>,
    ];
    expect(url).toBe("https://session.example/rollup");
    expect(reader.equals(key.publicKey)).toBe(true);
    const challenge = new TextEncoder().encode(
      `Login to Query Filtering Service\nTimestamp: 1700000000\nUser: ${key.publicKey.toBase58()}`,
    );
    expect(
      nacl.sign.detached.verify(challenge, await signMessage(challenge), key.publicKey.toBytes()),
    ).toBe(true);
    await expect(signMessage(new TextEncoder().encode("challenge"))).rejects.toThrow(
      /not a sign-in/,
    );
    expect(connect).toHaveBeenCalledWith("https://session.example/rollup", "tok");
  });
});
