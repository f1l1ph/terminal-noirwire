import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { clearWallet, createWallet, importWallet, bytesToHex } from "@/lib/wallet/index";
import { trackSecret } from "@/lib/rollup/secretStore";
import { saveCheckpoint } from "@/lib/rollup/checkpointStore";
import { deriveRollupOwnFills } from "@/lib/rollup/ownFills";

function memoryStore() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

describe("audit: browser wallet storage", () => {
  it("the owner secret is not stored as readable plaintext", () => {
    const store = memoryStore();
    const account = createWallet(store);
    const stored = [...store.map.values()].join("\n");
    expect(stored.includes(account.secretKeyHex)).toBe(false);
  });

  it("importing a secret does not silently overwrite an existing wallet", () => {
    const store = memoryStore();
    const first = createWallet(store);
    const other = Keypair.generate();
    try {
      importWallet(store, bytesToHex(other.secretKey));
    } catch {
      // refusing is the acceptable outcome
    }
    const stillRecoverable = [...store.map.values()].some((v) => v.includes(first.secretKeyHex));
    expect(stillRecoverable).toBe(true);
  });

  it("removing the wallet also removes its order secrets and key checkpoint", () => {
    const store = memoryStore();
    const account = createWallet(store);
    trackSecret(store, account.publicKey, "NSOL-PERP", new Uint8Array(16).fill(7));
    saveCheckpoint(store, account.publicKey, { indices: [0, 1, 2, 3], nextIndex: 4 });
    clearWallet(store);
    expect([...store.map.keys()]).toEqual([]);
  });
});

describe("audit: own-fill derivation over service-supplied tape rows", () => {
  it("a non-integer sequence in one row does not take down own-fill recognition", () => {
    const row = (sequence: number) => ({
      market: "NSOL-PERP",
      price: "150",
      size: "1",
      takerSide: "buy" as const,
      takerTag: "1",
      makerTag: "2",
      timestampMs: 0,
      sequence,
    });
    const run = () => deriveRollupOwnFills([row(1), row(1.5)], [new Uint8Array(16)]);
    expect(run).not.toThrow();
  });
});
