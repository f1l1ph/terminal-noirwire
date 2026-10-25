import { describe, expect, it, vi } from "vitest";
import { Keypair, type Connection } from "@solana/web3.js";
import { ownerDataKeys, type KeyValueStore } from "@/lib/wallet/index";
import { keypairOwnerSigner, type OwnerSigner } from "@/lib/wallet/ownerSigner";
import {
  clearSignInToken,
  signedInReader,
  TOKEN_REFRESH_MARGIN_MS,
  trackConnectedOwner,
  type SignInDeps,
} from "@/lib/rollup/signInToken";

const DAY_MS = 24 * 60 * 60 * 1000;
const URL = "https://rollup.example";

const memoryStore = (map = new Map<string, string>()): KeyValueStore => ({
  getItem: (key) => map.get(key) ?? null,
  setItem: (key, value) => void map.set(key, value),
  removeItem: (key) => void map.delete(key),
});

/** One page load: its own wallet and clock, sharing only what the browser keeps (`storage`). */
function page(storage: KeyValueStore, nowMs: { value: number }, keypair = Keypair.generate()) {
  const real = keypairOwnerSigner(keypair);
  const signMessage = vi.fn(real.signMessage);
  const owner: OwnerSigner = { ...real, signMessage };
  let issued = 0;
  const signIn: SignInDeps["signIn"] = async (_url, reader, sign) => {
    await sign(
      new TextEncoder().encode(
        `Login to Query Filtering Service\nTimestamp: 1\nUser: ${reader.toBase58()}`,
      ),
    );
    issued += 1;
    return { token: `token-number-${issued}`, expiresAtMs: nowMs.value + 30 * DAY_MS };
  };
  const connect = vi.fn((_url: string, _token: string) => ({}) as Connection);
  const deps: SignInDeps = {
    rollupRpcUrl: URL,
    owner,
    storage,
    now: () => nowMs.value,
    signIn,
    connect,
  };
  return { deps, signMessage, connect, owner, keypair };
}

describe("the rollup sign-in token", () => {
  it("is asked of the wallet once, then reused across a reload without another prompt", async () => {
    const storage = memoryStore();
    const clock = { value: 1_000 };
    const first = page(storage, clock);
    await signedInReader(first.deps);

    const reloaded = page(storage, clock, first.keypair);
    const again = await signedInReader(reloaded.deps);

    expect(first.signMessage).toHaveBeenCalledTimes(1);
    expect(reloaded.signMessage).not.toHaveBeenCalled();
    expect(again.cached).toBe(true);
    expect(reloaded.connect).toHaveBeenCalledWith(URL, "token-number-1");
  });

  it("is signed for again once less than the refresh margin of it is left", async () => {
    const storage = memoryStore();
    const clock = { value: 0 };
    const first = page(storage, clock);
    await signedInReader(first.deps);

    clock.value = 30 * DAY_MS - TOKEN_REFRESH_MARGIN_MS + 1;
    const later = page(storage, clock, first.keypair);
    const renewed = await signedInReader(later.deps);

    expect(later.signMessage).toHaveBeenCalledTimes(1);
    expect(renewed.cached).toBe(false);
  });

  it("is kept for weeks, not a day: no prompt a day later", async () => {
    const storage = memoryStore();
    const clock = { value: 0 };
    const first = page(storage, clock);
    await signedInReader(first.deps);

    clock.value = DAY_MS;
    const nextDay = page(storage, clock, first.keypair);
    await signedInReader(nextDay.deps);

    expect(nextDay.signMessage).not.toHaveBeenCalled();
  });

  it("is signed for afresh, and the new one kept, when the rollup refused the cached one", async () => {
    const storage = memoryStore();
    const clock = { value: 0 };
    const first = page(storage, clock);
    await signedInReader(first.deps);

    const retry = page(storage, clock, first.keypair);
    await signedInReader(retry.deps, { fresh: true });
    const after = page(storage, clock, first.keypair);
    await signedInReader(after.deps);

    expect(retry.signMessage).toHaveBeenCalledTimes(1);
    expect(after.signMessage).not.toHaveBeenCalled();
    expect(after.connect).toHaveBeenCalledWith(URL, "token-number-1");
  });

  it("belongs to one owner: another account on this device signs in itself", async () => {
    const storage = memoryStore();
    const clock = { value: 0 };
    await signedInReader(page(storage, clock).deps);

    const other = page(storage, clock);
    await signedInReader(other.deps);

    expect(other.signMessage).toHaveBeenCalledTimes(1);
  });

  it("ignores a stored value that is not a token", async () => {
    const keypair = Keypair.generate();
    const storage = memoryStore(
      new Map([[ownerDataKeys.signInToken(keypair.publicKey.toBase58()), "{not json"]]),
    );
    const fresh = page(storage, { value: 0 }, keypair);
    await signedInReader(fresh.deps);
    expect(fresh.signMessage).toHaveBeenCalledTimes(1);
  });
});

describe("the token is wiped when its owner stops being connected", () => {
  const ownerA = Keypair.generate().publicKey.toBase58();
  const ownerB = Keypair.generate().publicKey.toBase58();

  const tokenOf = (storage: KeyValueStore, address: string) =>
    storage.getItem(ownerDataKeys.signInToken(address));

  async function withTokenFor(keypair: Keypair, storage: KeyValueStore) {
    await signedInReader(page(storage, { value: 0 }, keypair).deps);
    return keypair.publicKey.toBase58();
  }

  it("on disconnect", async () => {
    const storage = memoryStore();
    const address = await withTokenFor(Keypair.generate(), storage);
    const track = trackConnectedOwner((gone) => clearSignInToken(storage, gone));
    track(address);
    track(null);
    expect(tokenOf(storage, address)).toBeNull();
  });

  it("on an account change in the wallet", async () => {
    const storage = memoryStore();
    const address = await withTokenFor(Keypair.generate(), storage);
    const track = trackConnectedOwner((gone) => clearSignInToken(storage, gone));
    track(address);
    track(ownerB);
    expect(tokenOf(storage, address)).toBeNull();
  });

  it("not on a page that loads with the owner already connected", async () => {
    const storage = memoryStore();
    const address = await withTokenFor(Keypair.generate(), storage);
    const track = trackConnectedOwner((gone) => clearSignInToken(storage, gone));
    track(address);
    track(address);
    expect(tokenOf(storage, address)).not.toBeNull();
  });

  it("leaves another owner's token alone", async () => {
    const storage = memoryStore();
    const kept = await withTokenFor(Keypair.generate(), storage);
    const track = trackConnectedOwner((gone) => clearSignInToken(storage, gone));
    track(ownerA);
    track(null);
    expect(tokenOf(storage, kept)).not.toBeNull();
  });
});
