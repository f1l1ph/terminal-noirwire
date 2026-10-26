import { describe, expect, it } from "vitest";
import { Keypair, type Connection } from "@solana/web3.js";
import { ownerDataKeys } from "@/lib/wallet/index";
import { StaleSigner, keypairOwnerSigner } from "@/lib/wallet/ownerSigner";
import {
  clearOtherSignInTokens,
  clearSignInToken,
  saveSignInToken,
  signedInReader,
  trackConnectedOwner,
  type ListableStore,
  type SignInDeps,
} from "@/lib/rollup/signInToken";

const FAR = 10 ** 13;

function listableStore(): ListableStore {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

describe("a sign-in still in flight when its owner disconnects", () => {
  it("saves no token and fails as a stale signer", async () => {
    const storage = listableStore();
    const keypair = Keypair.generate();
    const address = keypair.publicKey.toBase58();
    const deps: SignInDeps = {
      rollupRpcUrl: "https://rollup.example",
      owner: keypairOwnerSigner(keypair),
      storage,
      now: () => 0,
      signIn: async () => {
        clearSignInToken(storage, address);
        return { token: "token-number-1", expiresAtMs: FAR };
      },
      connect: () => ({}) as Connection,
    };
    await expect(signedInReader(deps)).rejects.toBeInstanceOf(StaleSigner);
    expect(storage.getItem(ownerDataKeys.signInToken(address))).toBeNull();
  });
});

describe("a token left by an owner of an earlier visit", () => {
  const a = Keypair.generate().publicKey.toBase58();
  const b = Keypair.generate().publicKey.toBase58();

  it("is wiped when another owner connects", () => {
    const storage = listableStore();
    saveSignInToken(storage, a, "token-of-owner-a", FAR);
    const track = trackConnectedOwner(
      (gone) => clearSignInToken(storage, gone),
      (connected) => clearOtherSignInTokens(storage, connected),
    );
    track(b);
    expect(storage.getItem(ownerDataKeys.signInToken(a))).toBeNull();
  });

  it("is the only thing wiped: the connected owner's own token stays", () => {
    const storage = listableStore();
    saveSignInToken(storage, a, "token-of-owner-a", FAR);
    saveSignInToken(storage, b, "token-of-owner-b", FAR);
    clearOtherSignInTokens(storage, b);
    expect(storage.getItem(ownerDataKeys.signInToken(b))).not.toBeNull();
  });

  it("leaves unrelated storage alone", () => {
    const storage = listableStore();
    storage.setItem("something-else", "kept");
    clearOtherSignInTokens(storage, b);
    expect(storage.getItem("something-else")).toBe("kept");
  });
});
