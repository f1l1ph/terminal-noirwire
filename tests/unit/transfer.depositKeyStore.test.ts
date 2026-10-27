import { describe, expect, it } from "vitest";
import { loadOrCreateDepositKey, type SeedPort } from "@/lib/transfer/depositKeyStore";

function memorySeeds(): SeedPort & { created: string[] } {
  const stored = new Map<string, Uint8Array>();
  const created: string[] = [];
  return {
    created,
    load: async (name) => stored.get(name) ?? null,
    create: async (name) => {
      created.push(name);
      const seed = crypto.getRandomValues(new Uint8Array(32));
      stored.set(name, seed);
      return seed;
    },
  };
}

describe("the owner's deposit key", () => {
  it("is made once, stored before it is returned, and found again", async () => {
    const seeds = memorySeeds();
    const first = await loadOrCreateDepositKey("owner1", seeds);
    const again = await loadOrCreateDepositKey("owner1", seeds);
    expect(again.publicKey.equals(first.publicKey)).toBe(true);
    expect(seeds.created).toHaveLength(1);
  });

  it("is a different key for each owner", async () => {
    const seeds = memorySeeds();
    const a = await loadOrCreateDepositKey("owner1", seeds);
    const b = await loadOrCreateDepositKey("owner2", seeds);
    expect(a.publicKey.equals(b.publicKey)).toBe(false);
  });

  it("is never made when storing it fails", async () => {
    const seeds: SeedPort = {
      load: async () => null,
      create: async () => {
        throw new Error("browser storage is unavailable");
      },
    };
    await expect(loadOrCreateDepositKey("owner1", seeds)).rejects.toThrow(/unavailable/);
  });
});
