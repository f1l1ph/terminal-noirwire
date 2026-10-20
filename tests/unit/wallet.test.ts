import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import {
  bytesToHex,
  clearWallet,
  createWallet,
  hexToBytes,
  importWallet,
  loadLegacyWallet,
  lockedWalletAddress,
  MIN_PASSPHRASE_LENGTH,
  protectWallet,
  storedWalletAddress,
  unlockWallet,
  WalletExistsError,
  type KeyValueStore,
} from "@/lib/wallet";

function memoryStore(): KeyValueStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

const LEGACY_SECRET_KEY = "noirwire-terminal-wallet-secret";

describe("hex helpers", () => {
  it("round-trips bytes through hex", () => {
    const bytes = new Uint8Array([0, 1, 255, 16]);
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
  });

  it("rejects an odd-length or non-hex string", () => {
    expect(() => hexToBytes("abc")).toThrow();
    expect(() => hexToBytes("zz")).toThrow();
  });
});

describe("wallet storage", () => {
  it("creates a wallet without writing its secret anywhere, only its address", () => {
    const store = memoryStore();
    const created = createWallet(store);
    expect([...store.map.values()]).toEqual([created.publicKey]);
    expect(storedWalletAddress(store)).toBe(created.publicKey);
  });

  it("encrypts the wallet under a passphrase and unlocks the same account back", async () => {
    const store = memoryStore();
    const created = createWallet(store);
    await protectWallet(store, created, "correct horse");

    expect([...store.map.values()].join("\n")).not.toContain(created.secretKeyHex);
    expect(lockedWalletAddress(store)).toBe(created.publicKey);
    expect(await unlockWallet(store, "correct horse")).toEqual(created);
  });

  it("does not unlock with a wrong passphrase", async () => {
    const store = memoryStore();
    const created = createWallet(store);
    await protectWallet(store, created, "correct horse");
    expect(await unlockWallet(store, "wrong horse")).toBeNull();
  });

  it("refuses an encrypted secret relabelled with another address", async () => {
    const store = memoryStore();
    const created = createWallet(store);
    await protectWallet(store, created, "correct horse");
    const key = [...store.map.keys()].find((name) => name.endsWith("-sealed"))!;
    const sealed = JSON.parse(store.map.get(key)!);
    store.map.set(
      key,
      JSON.stringify({ ...sealed, publicKey: Keypair.generate().publicKey.toBase58() }),
    );
    expect(await unlockWallet(store, "correct horse")).toBeNull();
  });

  it("encrypts a plain-text wallet from an earlier build and removes the plain text", async () => {
    const store = memoryStore();
    const legacy = Keypair.generate();
    store.setItem(LEGACY_SECRET_KEY, bytesToHex(legacy.secretKey));

    const loaded = loadLegacyWallet(store);
    expect(loaded?.publicKey).toBe(legacy.publicKey.toBase58());
    await protectWallet(store, loaded!, "correct horse");

    expect(store.getItem(LEGACY_SECRET_KEY)).toBeNull();
    expect(loadLegacyWallet(store)).toBeNull();
    expect((await unlockWallet(store, "correct horse"))?.publicKey).toBe(loaded!.publicKey);
  });

  it("refuses to create a second wallet over an encrypted one", async () => {
    const store = memoryStore();
    await protectWallet(store, createWallet(store), "correct horse");
    expect(() => createWallet(store)).toThrow(WalletExistsError);
  });

  it("imports a secret exported from another device and gets the same address", () => {
    const account = createWallet(memoryStore());
    const imported = importWallet(memoryStore(), account.secretKeyHex);
    expect(imported.publicKey).toBe(account.publicKey);
  });

  it("rejects an invalid secret on import", () => {
    expect(() => importWallet(memoryStore(), "not-hex")).toThrow();
  });

  it("imports over a different wallet only when asked to replace it, and then forgets the old one", async () => {
    const store = memoryStore();
    const first = createWallet(store);
    await protectWallet(store, first, "correct horse");
    store.setItem(`noirwire-terminal-rollup-secrets-${first.publicKey}`, "[]");
    const other = bytesToHex(Keypair.generate().secretKey);

    expect(() => importWallet(store, other)).toThrow(WalletExistsError);
    expect(lockedWalletAddress(store)).toBe(first.publicKey);

    const replaced = importWallet(store, other, { replace: true });
    expect(storedWalletAddress(store)).toBe(replaced.publicKey);
    expect(lockedWalletAddress(store)).toBeNull();
    expect(store.getItem(`noirwire-terminal-rollup-secrets-${first.publicKey}`)).toBeNull();
  });

  it("importing the wallet already kept here changes nothing", async () => {
    const store = memoryStore();
    const first = createWallet(store);
    await protectWallet(store, first, "correct horse");
    expect(importWallet(store, first.secretKeyHex)).toEqual(first);
    expect(lockedWalletAddress(store)).toBe(first.publicKey);
  });

  it("refuses a passphrase shorter than the minimum", async () => {
    const store = memoryStore();
    const created = createWallet(store);
    await expect(protectWallet(store, created, "a")).rejects.toThrow();
    await expect(
      protectWallet(store, created, "x".repeat(MIN_PASSPHRASE_LENGTH - 1)),
    ).rejects.toThrow();
    expect(lockedWalletAddress(store)).toBeNull();
  });

  it("refuses a stored secret whose iteration count is not this build's", async () => {
    const store = memoryStore();
    const created = createWallet(store);
    await protectWallet(store, created, "correct horse");
    const key = [...store.map.keys()].find((name) => name.endsWith("-sealed"))!;
    const sealed = JSON.parse(store.map.get(key)!);
    for (const iterations of [1, 1_000_000_000]) {
      store.map.set(key, JSON.stringify({ ...sealed, iterations }));
      expect(lockedWalletAddress(store)).toBeNull();
      expect(await unlockWallet(store, "correct horse")).toBeNull();
    }
  });

  it("forgets what a wallet lost before it was saved left behind, when a new one is created", () => {
    const store = memoryStore();
    const lost = createWallet(store);
    store.setItem(`noirwire-terminal-rollup-secrets-${lost.publicKey}`, "[]");
    store.setItem(`noirwire-terminal-grant-used:${lost.publicKey}`, "1");

    const next = createWallet(store);
    expect([...store.map.entries()]).toEqual([
      ["noirwire-terminal-wallet-address", next.publicKey],
    ]);
  });

  it("imports over a wallet lost before it was saved without asking, forgetting its data", () => {
    const store = memoryStore();
    const lost = createWallet(store);
    store.setItem(`noirwire-terminal-rollup-secrets-${lost.publicKey}`, "[]");
    const imported = importWallet(store, bytesToHex(Keypair.generate().secretKey));
    expect(storedWalletAddress(store)).toBe(imported.publicKey);
    expect(store.getItem(`noirwire-terminal-rollup-secrets-${lost.publicKey}`)).toBeNull();
  });

  it("asks before importing over a wallet held in memory and not saved yet", () => {
    const store = memoryStore();
    const held = createWallet(store);
    const other = bytesToHex(Keypair.generate().secretKey);
    expect(() => importWallet(store, other, { heldAddress: held.publicKey })).toThrow(
      WalletExistsError,
    );
    expect(storedWalletAddress(store)).toBe(held.publicKey);
    expect(importWallet(store, held.secretKeyHex, { heldAddress: held.publicKey })).toEqual(held);
  });

  it("re-importing a wallet lost before it was saved keeps its order data", () => {
    const store = memoryStore();
    const lost = createWallet(store);
    store.setItem(`noirwire-terminal-rollup-secrets-${lost.publicKey}`, "[]");
    expect(importWallet(store, lost.secretKeyHex)).toEqual(lost);
    expect(store.getItem(`noirwire-terminal-rollup-secrets-${lost.publicKey}`)).toBe("[]");
  });

  it("clears the stored wallet", async () => {
    const store = memoryStore();
    await protectWallet(store, createWallet(store), "correct horse");
    clearWallet(store);
    expect(store.map.size).toBe(0);
    expect(storedWalletAddress(store)).toBeNull();
  });
});
