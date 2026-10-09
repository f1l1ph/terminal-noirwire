import { describe, expect, it } from "vitest";
import {
  bytesToHex,
  clearWallet,
  createWallet,
  exportSecret,
  hexToBytes,
  importWallet,
  loadWallet,
  type KeyValueStore,
} from "@/lib/wallet";

function memoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

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
  it("creates a wallet, persists it, and loads the same account back", () => {
    const store = memoryStore();
    const created = createWallet(store);
    const loaded = loadWallet(store);
    expect(loaded).toEqual(created);
  });

  it("has no wallet to load before one is created", () => {
    expect(loadWallet(memoryStore())).toBeNull();
  });

  it("imports a secret exported from another store and gets the same address", () => {
    const storeA = memoryStore();
    const account = createWallet(storeA);
    const secret = exportSecret(storeA);
    expect(secret).not.toBeNull();

    const storeB = memoryStore();
    const imported = importWallet(storeB, secret!);
    expect(imported.publicKey).toBe(account.publicKey);
  });

  it("rejects an invalid secret on import", () => {
    expect(() => importWallet(memoryStore(), "not-hex")).toThrow();
  });

  it("clears the stored wallet", () => {
    const store = memoryStore();
    createWallet(store);
    clearWallet(store);
    expect(loadWallet(store)).toBeNull();
  });
});
