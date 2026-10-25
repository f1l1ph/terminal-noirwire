import { describe, expect, it } from "vitest";
import {
  createOrderSeedStore,
  type SeedBackend,
  type WrappedSeed,
} from "@/lib/rollup/orderSeedStore";

function memoryBackend() {
  let key: CryptoKey | undefined;
  const seeds = new Map<string, WrappedSeed>();
  const state = { failing: false };
  const guard = () => {
    if (state.failing) throw new Error("storage unavailable");
  };
  const backend: SeedBackend = {
    getKey: async () => key,
    addKey: async (next) => {
      guard();
      if (key) return false;
      key = next;
      return true;
    },
    getSeed: async (owner) => seeds.get(owner),
    addSeed: async (owner, wrapped) => {
      guard();
      if (seeds.has(owner)) return false;
      seeds.set(owner, wrapped);
      return true;
    },
    deleteSeed: async (owner) => {
      seeds.delete(owner);
    },
  };
  return { backend, seeds, state, storedKey: () => key };
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("the order seed store", () => {
  it("gives the same owner the same 32-byte seed back", async () => {
    const store = createOrderSeedStore(memoryBackend().backend);
    const created = await store.create("owner-a");
    expect(created).toHaveLength(32);
    expect(hex((await store.load("owner-a"))!)).toBe(hex(created));
  });

  it("gives another owner a different seed", async () => {
    const store = createOrderSeedStore(memoryBackend().backend);
    const a = await store.create("owner-a");
    const b = await store.create("owner-b");
    expect(hex(a)).not.toBe(hex(b));
  });

  it("holds the seed only wrapped, under a non-extractable key", async () => {
    const memory = memoryBackend();
    const store = createOrderSeedStore(memory.backend);
    const seed = await store.create("owner-a");
    const wrapped = memory.seeds.get("owner-a")!;
    expect(hex(wrapped.ciphertext)).not.toContain(hex(seed));
    expect(memory.storedKey()!.extractable).toBe(false);
  });

  it("does not open one owner's record as another's", async () => {
    const memory = memoryBackend();
    const store = createOrderSeedStore(memory.backend);
    await store.create("owner-a");
    memory.seeds.set("owner-b", memory.seeds.get("owner-a")!);
    await expect(store.load("owner-b")).rejects.toThrow();
  });

  it("throws on create when storage fails, and stores nothing", async () => {
    const memory = memoryBackend();
    memory.state.failing = true;
    const store = createOrderSeedStore(memory.backend);
    await expect(store.create("owner-a")).rejects.toThrow();
    expect(await store.load("owner-a")).toBeNull();
  });

  it("returns the stored seed when another tab created one first", async () => {
    const memory = memoryBackend();
    const store = createOrderSeedStore(memory.backend);
    const first = await store.create("owner-a");
    const second = await store.create("owner-a");
    expect(hex(second)).toBe(hex(first));
  });

  it("refuses a planted extractable wrapping key and does not replace it", async () => {
    const memory = memoryBackend();
    const planted = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ]);
    await memory.backend.addKey(planted);
    const store = createOrderSeedStore(memory.backend);
    await expect(store.create("owner-a")).rejects.toThrow();
    expect(memory.storedKey()).toBe(planted);
    expect(memory.seeds.size).toBe(0);
  });

  it("refuses a wrapping key with more usages than encrypt and decrypt", async () => {
    const memory = memoryBackend();
    await memory.backend.addKey(
      await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
        "wrapKey",
      ]),
    );
    await expect(createOrderSeedStore(memory.backend).create("owner-a")).rejects.toThrow();
  });

  it("records whether the browser granted persistent storage", async () => {
    const store = createOrderSeedStore(memoryBackend().backend, async () => true);
    expect(store.persisted()).toBeNull();
    await store.create("owner-a");
    expect(store.persisted()).toBe(true);
  });

  it("forgets the seed", async () => {
    const store = createOrderSeedStore(memoryBackend().backend);
    await store.create("owner-a");
    await store.forget("owner-a");
    expect(await store.load("owner-a")).toBeNull();
  });
});
