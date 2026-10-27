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
  storedDepositKeys,
  storedKeyMatching,
  type SeedPort,
  type SignMessage,
} from "@/lib/transfer/depositKeyStore";
import { depositKeyLeftover, readDepositKeyLeftover } from "@/lib/transfer/leftover";
import {
  KEY_SIGNATURE_NOTE,
  NO_UNFINISHED_DEPOSIT,
  TRANSFER_STILL_OPEN,
  outcomeLine,
} from "@/lib/transfer/outcomeCopy";
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

  it("moves a new deposit to the derived key and leaves a stored random key alone", async () => {
    const wallet = Keypair.generate();
    const owner = wallet.publicKey.toBase58();
    const seeds = memorySeeds();
    const random = await loadOrCreateDepositKey(owner, undefined, seeds);
    const sign = vi.fn(signingAs(wallet));
    const fresh = await loadOrCreateDepositKey(owner, sign, seeds);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(fresh.derived).toBe(true);
    expect(fresh.keypair.publicKey.equals(random.keypair.publicKey)).toBe(false);
    const kept = await storedDepositKeys(owner, seeds);
    expect(kept[0].keypair.publicKey.equals(random.keypair.publicKey)).toBe(true);
    expect(seeds.created).toEqual([`deposit-key:${owner}`, `deposit-key-derived:${owner}`]);
  });

  it("uses the stored random key for a new deposit only when the wallet cannot sign", async () => {
    const owner = Keypair.generate().publicKey.toBase58();
    const seeds = memorySeeds();
    const random = await loadOrCreateDepositKey(owner, undefined, seeds);
    const again = await loadOrCreateDepositKey(owner, undefined, seeds);
    expect(again.keypair.publicKey.equals(random.keypair.publicKey)).toBe(true);
    expect(again.fellBack).toBe(true);
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

describe("recovery in a browser that already holds a random key", () => {
  it("uses the derived key, leaves the random key alone, and asks the wallet once", async () => {
    const wallet = Keypair.generate();
    const owner = wallet.publicKey.toBase58();
    const seeds = memorySeeds();
    const random = await loadOrCreateDepositKey(owner, undefined, seeds);
    const sign = vi.fn(signingAs(wallet));
    const derived = await deriveDepositKey(owner, sign, seeds);
    const again = await deriveDepositKey(owner, sign, seeds);
    const elsewhere = await deriveDepositKey(owner, signingAs(wallet), memorySeeds());
    expect(derived.derived).toBe(true);
    expect(derived.keypair.publicKey.equals(elsewhere.keypair.publicKey)).toBe(true);
    expect(derived.keypair.publicKey.equals(random.keypair.publicKey)).toBe(false);
    expect(again.keypair.publicKey.equals(derived.keypair.publicKey)).toBe(true);
    expect(sign).toHaveBeenCalledTimes(1);
    const next = await loadOrCreateDepositKey(owner, sign, seeds);
    expect(next.keypair.publicKey.equals(derived.keypair.publicKey)).toBe(true);
    expect(next.keypair.publicKey.equals(random.keypair.publicKey)).toBe(false);
    expect(next.derived).toBe(true);
    expect(sign).toHaveBeenCalledTimes(1);
  });
});

describe("the key an open record is carried on with", () => {
  const both = async () => {
    const wallet = Keypair.generate();
    const owner = wallet.publicKey.toBase58();
    const seeds = memorySeeds();
    const random = await loadOrCreateDepositKey(owner, undefined, seeds);
    const derived = await deriveDepositKey(owner, signingAs(wallet), seeds);
    return { owner, seeds, random, derived };
  };

  it("is the derived key when the record was made with it, though a random key is stored", async () => {
    const { owner, seeds, random, derived } = await both();
    const found = await storedKeyMatching(owner, derived.keypair.publicKey.toBase58(), seeds);
    expect(found?.derived).toBe(true);
    expect(found?.keypair.publicKey.equals(derived.keypair.publicKey)).toBe(true);
    expect(found?.keypair.publicKey.equals(random.keypair.publicKey)).toBe(false);
  });

  it("is the random key when the record was made with it", async () => {
    const { owner, seeds, random } = await both();
    const found = await storedKeyMatching(owner, random.keypair.publicKey.toBase58(), seeds);
    expect(found?.derived).toBe(false);
    expect(found?.keypair.publicKey.equals(random.keypair.publicKey)).toBe(true);
  });

  it("is nothing without a record or for a key this browser does not hold", async () => {
    const { owner, seeds, random } = await both();
    expect(await storedKeyMatching(owner, undefined, seeds)).toBeNull();
    expect(
      await storedKeyMatching(owner, Keypair.generate().publicKey.toBase58(), seeds),
    ).toBeNull();
    expect(
      (await storedDepositKey(owner, seeds))?.keypair.publicKey.equals(random.keypair.publicKey),
    ).toBe(true);
  });

  it("resumes a record made with the derived key, in a world holding that key", async () => {
    const { derived } = await both();
    const world = makeWorld({ depositKey: derived.keypair });
    world.solana.script({ fate: "land", effect: world.moveEffect(ATOMS) });
    world.rollup.script({ fate: "fail" });
    expect(await deposit(world.env, { amount: "2.5" })).toMatchObject({ status: "stranded" });
    const [record] = [...world.rows.values()];
    expect(record.depositKey).toBe(derived.keypair.publicKey.toBase58());
    world.rollup.script({ fate: "land", effect: world.depositEffect(ATOMS) });
    const resumed = await deposit(world.env, {
      amount: "2.5",
      intent: { kind: "resume", id: record.id, atoms: record.atoms },
    });
    expect(resumed).toMatchObject({ status: "done" });
  });
});

describe("an open record whose key is not the stored one", () => {
  it("is refused with a pointer to finishing from another browser", async () => {
    const world = makeWorld({ depositKey: Keypair.generate() });
    world.solana.script({ fate: "land", effect: world.moveEffect(ATOMS) });
    world.rollup.script({ fate: "fail" });
    await deposit(world.env, { amount: "2.5" });
    const [record] = [...world.rows.values()];
    world.env.depositKey = Keypair.generate();
    const refused = await deposit(world.env, {
      amount: "2.5",
      intent: { kind: "resume", id: record.id, atoms: record.atoms },
    });
    expect(refused).toMatchObject({ status: "refused", reason: "deposit-key-missing" });
    expect((refused as { message: string }).message).toMatch(
      /use Finish a deposit from another browser/,
    );
  });

  it("is told apart from a free browser by the line shown", () => {
    expect(TRANSFER_STILL_OPEN).toBe(
      "Another transfer is still open in this browser. Finish it first, then try again.",
    );
  });
});

describe("reading what the deposit key holds", () => {
  it("is zero for a key with no balance account", async () => {
    const world = makeWorld({ depositKey: Keypair.generate() });
    expect(await readDepositKeyLeftover(world.env)).toBe(0n);
  });

  it("is the balance when the key holds one", async () => {
    const world = makeWorld({ depositKey: Keypair.generate() });
    world.delegateKey(ATOMS);
    expect(await readDepositKeyLeftover(world.env)).toBe(ATOMS);
  });

  it("throws when the rollup cannot be read, though the background read says nothing", async () => {
    const world = makeWorld({ depositKey: Keypair.generate() });
    world.delegateKey(ATOMS);
    world.env.depositRollup = async () => {
      throw new Error("sign-in refused");
    };
    await expect(readDepositKeyLeftover(world.env)).rejects.toThrow(/sign-in refused/);
    expect(await depositKeyLeftover(world.env)).toBeNull();
  });
});

describe("a leftover under the derived key with a random key also stored", () => {
  it("is found by checking every stored key", async () => {
    const wallet = Keypair.generate();
    const owner = wallet.publicKey.toBase58();
    const seeds = memorySeeds();
    const random = await loadOrCreateDepositKey(owner, undefined, seeds);
    const derived = await deriveDepositKey(owner, signingAs(wallet), seeds);
    const keys = await storedDepositKeys(owner, seeds);
    expect(keys.map((key) => key.derived)).toEqual([false, true]);
    const held = new Map([[derived.keypair.publicKey.toBase58(), ATOMS]]);
    const found: bigint[] = [];
    for (const key of keys) {
      const world = makeWorld({ depositKey: key.keypair });
      world.delegateKey(held.get(key.keypair.publicKey.toBase58()) ?? 0n);
      const atoms = await depositKeyLeftover(world.env);
      if (atoms !== null) found.push(atoms);
    }
    expect(found).toEqual([ATOMS]);
    expect(keys[0].keypair.publicKey.equals(random.keypair.publicKey)).toBe(true);
  });
});

describe("a wallet that cannot give a derived key", () => {
  const owner = () => Keypair.generate();

  it("gets a stored random key and the flag when it cannot sign at all", async () => {
    const seeds = memorySeeds();
    const address = owner().publicKey.toBase58();
    const key = await loadOrCreateDepositKey(address, undefined, seeds);
    expect(key).toMatchObject({ derived: false, fellBack: true });
    expect(seeds.created).toEqual([`deposit-key:${address}`]);
    expect((await loadOrCreateDepositKey(address, undefined, seeds)).fellBack).toBe(true);
    expect(seeds.created).toHaveLength(1);
  });

  it("gets one when signing fails for a reason that is not a decline", async () => {
    const seeds = memorySeeds();
    const address = owner().publicKey.toBase58();
    const broken = async () => {
      throw new Error("the wallet is locked");
    };
    const key = await loadOrCreateDepositKey(address, broken, seeds);
    expect(key).toMatchObject({ derived: false, fellBack: true });
    expect(seeds.created).toEqual([`deposit-key:${address}`]);
  });

  it("gets one when the signature does not verify", async () => {
    const seeds = memorySeeds();
    const wallet = owner();
    const key = await loadOrCreateDepositKey(
      wallet.publicKey.toBase58(),
      signingAs(Keypair.generate()),
      seeds,
    );
    expect(key).toMatchObject({ derived: false, fellBack: true });
  });

  it("still stops when the owner declines", async () => {
    const seeds = memorySeeds();
    const declined = async () => {
      throw new Error("User rejected the request.");
    };
    await expect(
      loadOrCreateDepositKey(owner().publicKey.toBase58(), declined, seeds),
    ).rejects.toBeInstanceOf(DepositKeyDeclined);
    expect(seeds.created).toEqual([]);
  });
});

describe("the copy around the deposit key", () => {
  it("tells a retry-later line when nothing is found yet", () => {
    expect(NO_UNFINISHED_DEPOSIT).toBe(
      "No unfinished deposit found for this wallet. If you just started one in another browser, wait a minute and try again.",
    );
  });

  it("says the first deposit here also signs a message, before the transaction", () => {
    expect(KEY_SIGNATURE_NOTE).toMatch(/sign a message that creates your deposit key/);
    expect(KEY_SIGNATURE_NOTE).toMatch(/before the transaction/);
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
