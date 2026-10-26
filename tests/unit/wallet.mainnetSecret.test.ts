import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { bytesToHex, createWallet, loadLegacyWallet, type KeyValueStore } from "@/lib/wallet/index";
import { keypairOwnerSigner } from "@/lib/wallet/ownerSigner";
import { ownerKeypairFrom, secretOwner } from "@/lib/wallet/secretSigner";
import { deriveOrderSeed } from "@/lib/rollup/keys";
import { MAINNET_PINS } from "@/lib/rollup/pins";
import { buildRealSession } from "@/lib/rollup/session";

const keypair = Keypair.generate();
const secret = { secretKeyHex: bytesToHex(keypair.secretKey) };

const memoryStore = (entries: Record<string, string> = {}): KeyValueStore => {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
};

afterEach(() => vi.unstubAllEnvs());

describe("a test build", () => {
  it("signs for the built-in wallet's own key", () => {
    expect(secretOwner(secret).signer.publicKey.equals(keypair.publicKey)).toBe(true);
  });
});

describe("a mainnet build holds no owner secret", () => {
  it("cannot turn a wallet secret into a keypair", () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    expect(() => ownerKeypairFrom(secret)).toThrow(/mainnet/);
  });

  it("cannot obtain an owner secret signer", () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    expect(() => secretOwner(secret)).toThrow(/mainnet/);
  });

  it("cannot wrap a keypair as an owner signer", () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    expect(() => keypairOwnerSigner(keypair)).toThrow(/mainnet/);
  });

  it("cannot derive an order seed from the owner secret", () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    expect(() => deriveOrderSeed(keypair)).toThrow(/mainnet/);
  });

  it("cannot create a wallet in the page", () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    expect(() => createWallet(memoryStore())).toThrow(/mainnet/);
  });

  it("does not read a plain-text secret an earlier build left in storage", () => {
    vi.stubEnv("NEXT_PUBLIC_NETWORK", "mainnet");
    const left = memoryStore({ "noirwire-terminal-wallet-secret": secret.secretKeyHex });
    expect(loadLegacyWallet(left)).toBeNull();
  });

  it("builds no session from a wallet secret, even when the build is pinned and the environment says test", async () => {
    const asked = vi.fn();
    const build = buildRealSession(
      { address: keypair.publicKey.toBase58(), ...secret },
      {
        simUrl: "https://sim.example",
        overrides: { pins: MAINNET_PINS },
        fetchFn: asked as unknown as typeof fetch,
      },
    );
    await expect(build).rejects.toThrow(/never takes a wallet secret/);
    expect(asked).not.toHaveBeenCalled();
  });
});
