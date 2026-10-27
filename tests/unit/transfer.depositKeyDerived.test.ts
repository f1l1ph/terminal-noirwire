import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { describe, expect, it, vi } from "vitest";
import { deposit, recoverDepositKey } from "@/lib/transfer/deposit";
import {
  DepositKeyDeclined,
  depositKeyMessage,
  deriveDepositKey,
  loadOrCreateDepositKey,
  storedDepositKey,
  type SeedPort,
  type SignMessage,
} from "@/lib/transfer/depositKeyStore";
import { depositKeyLeftover } from "@/lib/transfer/leftover";
import { outcomeLine } from "@/lib/transfer/outcomeCopy";
import { makeWorld } from "./transferWorld";

const ATOMS = 2_500_000n;

function memorySeeds(): SeedPort & { created: string[] } {
  const stored = new Map<string, Uint8Array>();
  const created: string[] = [];
  return {
    created,
    load: async (name) => stored.get(name) ?? null,
    create: async (name, given) => {
      created.push(name);
      const seed = given ?? crypto.getRandomValues(new Uint8Array(32));
      stored.set(name, seed);
      return seed;
    },
  };
}

const signingAs =
  (wallet: Keypair): SignMessage =>
  async (message) =>
    nacl.sign.detached(message, wallet.secretKey);

describe("a deposit key made from the wallet", () => {
  it("is the same key in any browser with the same wallet, and is marked derived", async () => {
    const wallet = Keypair.generate();
    const owner = wallet.publicKey.toBase58();
    const first = await deriveDepositKey(owner, signingAs(wallet), memorySeeds());
    const other = await deriveDepositKey(owner, signingAs(wallet), memorySeeds());
    expect(other.keypair.publicKey.equals(first.keypair.publicKey)).toBe(true);
    expect(first.derived).toBe(true);
  });

  it("is a different key for each owner", async () => {
    const a = Keypair.generate();
    const b = Keypair.generate();
    const keyA = await deriveDepositKey(a.publicKey.toBase58(), signingAs(a), memorySeeds());
    const keyB = await deriveDepositKey(b.publicKey.toBase58(), signingAs(b), memorySeeds());
    expect(keyA.keypair.publicKey.equals(keyB.keypair.publicKey)).toBe(false);
  });

  it("is stored, so the wallet is asked once per browser", async () => {
    const wallet = Keypair.generate();
    const owner = wallet.publicKey.toBase58();
    const seeds = memorySeeds();
    const sign = vi.fn(signingAs(wallet));
    const first = await loadOrCreateDepositKey(owner, sign, seeds);
    const again = await loadOrCreateDepositKey(owner, sign, seeds);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(again.keypair.publicKey.equals(first.keypair.publicKey)).toBe(true);
    expect(again.derived).toBe(true);
    expect((await storedDepositKey(owner, seeds))?.derived).toBe(true);
  });

  it("is refused when the signature does not verify, and nothing is stored", async () => {
    const wallet = Keypair.generate();
    const seeds = memorySeeds();
    await expect(
      deriveDepositKey(wallet.publicKey.toBase58(), signingAs(Keypair.generate()), seeds),
    ).rejects.toThrow(/did not verify/);
    await expect(
      deriveDepositKey(wallet.publicKey.toBase58(), async () => new Uint8Array(10), seeds),
    ).rejects.toThrow(/did not verify/);
    expect(seeds.created).toEqual([]);
  });

  it("never replaces a key already stored in this browser", async () => {
    const wallet = Keypair.generate();
    const owner = wallet.publicKey.toBase58();
    const seeds = memorySeeds();
    const random = await loadOrCreateDepositKey(owner, undefined, seeds);
    const sign = vi.fn(signingAs(wallet));
    const kept = await loadOrCreateDepositKey(owner, sign, seeds);
    expect(sign).not.toHaveBeenCalled();
    expect(kept.keypair.publicKey.equals(random.keypair.publicKey)).toBe(true);
    expect(kept.derived).toBe(false);
    expect(seeds.created).toHaveLength(1);
  });

  it("is a random key when the wallet cannot sign messages", async () => {
    const owner = Keypair.generate().publicKey.toBase58();
    const seeds = memorySeeds();
    const key = await loadOrCreateDepositKey(owner, undefined, seeds);
    expect(key.derived).toBe(false);
    expect(seeds.created).toEqual([`deposit-key:${owner}`]);
  });

  it("stops with a plain line when the signature is declined, storing nothing", async () => {
    const owner = Keypair.generate().publicKey.toBase58();
    const seeds = memorySeeds();
    const declined = async () => {
      throw new Error("User rejected the request.");
    };
    const failure = await loadOrCreateDepositKey(owner, declined, seeds).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(DepositKeyDeclined);
    expect((failure as Error).message).toBe(
      "Sign the message to create your deposit key. Nothing was sent.",
    );
    expect(seeds.created).toEqual([]);
    expect(await storedDepositKey(owner, seeds)).toBeNull();
  });

  it("does not pass another wallet failure off as a decline", async () => {
    const owner = Keypair.generate().publicKey.toBase58();
    const broken = async () => {
      throw new Error("the wallet is locked");
    };
    await expect(deriveDepositKey(owner, broken, memorySeeds())).rejects.toThrow(/locked/);
  });
});

describe("the message the wallet is asked to sign", () => {
  it("never starts like an owner action the program accepts, and names the owner", () => {
    const owner = Keypair.generate().publicKey.toBase58();
    const text = new TextDecoder().decode(depositKeyMessage(owner));
    expect(text.startsWith("NoirWire: ")).toBe(false);
    expect(text).not.toMatch(/\nprogram /);
    expect(text).toContain(`\nowner ${owner}\n`);
  });
});

describe("the derived marker", () => {
  const strand = async (derived: boolean) => {
    const world = makeWorld({ depositKey: Keypair.generate() });
    world.env.depositKeyDerived = derived;
    world.solana.script({ fate: "land", effect: world.moveEffect(ATOMS) });
    world.rollup.script({ fate: "fail" });
    const outcome = await deposit(world.env, { amount: "2.5" });
    return outcomeLine("deposit", outcome, 6, 35_000_000).text;
  };

  it("says a derived key's deposit can be finished from any browser with the wallet", async () => {
    expect(await strand(true)).toMatch(/any browser with this wallet can finish the deposit/);
  });

  it("keeps the old wording for a random key", async () => {
    const line = await strand(false);
    expect(line).toMatch(/held by this browser's deposit key/);
    expect(line).not.toMatch(/any browser/);
  });
});

describe("finishing a deposit from another browser", () => {
  const otherBrowserWorld = async () => {
    const wallet = Keypair.generate();
    const owner = wallet.publicKey.toBase58();
    const first = await deriveDepositKey(owner, signingAs(wallet), memorySeeds());
    const second = await deriveDepositKey(owner, signingAs(wallet), memorySeeds());
    expect(second.keypair.publicKey.equals(first.keypair.publicKey)).toBe(true);
    return makeWorld({ depositKey: second.keypair });
  };

  it("finds nothing when the key holds nothing", async () => {
    const world = await otherBrowserWorld();
    world.delegateKey(0n);
    expect(await depositKeyLeftover(world.env)).toBeNull();
  });

  it("puts what the key holds into the account with the existing recovery", async () => {
    const world = await otherBrowserWorld();
    world.delegateKey(ATOMS);
    expect(await depositKeyLeftover(world.env)).toBe(ATOMS);
    world.rollup.script({ fate: "land", effect: world.depositEffect(ATOMS) });
    expect(await recoverDepositKey(world.env)).toMatchObject({ status: "done", atoms: ATOMS });
    expect(world.rollup.token(world.keyAccount)).toBe(0n);
  });
});
