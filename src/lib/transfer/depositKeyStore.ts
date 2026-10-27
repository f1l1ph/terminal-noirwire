import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { messageDeclined } from "../rollup/ownerMessages";
import { createOrderSeed, loadOrderSeed } from "../rollup/orderSeedStore";

/** Where seeds are kept: one per name, written durably before it is returned. */
export interface SeedPort {
  load(name: string): Promise<Uint8Array | null>;
  /** Stores `seed` when it is passed, else a new random one. */
  create(name: string, seed?: Uint8Array): Promise<Uint8Array>;
}

/** The wallet's signature over exactly `message`. */
export type SignMessage = (message: Uint8Array) => Promise<Uint8Array>;

/** A deposit key, and whether the wallet can re-make it in another browser. */
export interface DepositKey {
  keypair: Keypair;
  derived: boolean;
  /** Set when a random key was made because the wallet could not give a derived one, so the user is told to finish in this browser. */
  fellBack?: boolean;
}

const browserSeeds: SeedPort = { load: loadOrderSeed, create: createOrderSeed };

const SIGNATURE_BYTES = 64;
const SEED_LABEL = "noirwire-deposit-key-v1";

const randomName = (owner: string) => `deposit-key:${owner}`;
/** A key made from the wallet is kept under its own name, which is how it is known to be derived. */
const derivedName = (owner: string) => `deposit-key-derived:${owner}`;

/** Thrown when the owner turns the signature down; no key is made and nothing is sent. */
export class DepositKeyDeclined extends Error {
  constructor() {
    super("Sign the message to create your deposit key. Nothing was sent.");
    this.name = "DepositKeyDeclined";
  }
}

/**
 * What the wallet is asked to sign for the deposit key. Its first line is not
 * "NoirWire: ", which every owner action the program accepts starts with, and
 * it carries no program line, so it can never stand for one.
 */
export function depositKeyMessage(owner: string): Uint8Array {
  return new TextEncoder().encode(
    `NoirWire deposit key\n\nSign to create the key that carries your deposits into the exchange. Any browser with this wallet re-creates the same key, so a deposit interrupted here can be finished from another browser. Only sign this on terminal.noirwire.com.\n\nowner ${owner}\nversion 1`,
  );
}

/** The seed for a wallet's deposit key: SHA-256 over a label and the signature, which Ed25519 makes the same every time. */
async function seedFromSignature(signature: Uint8Array): Promise<Uint8Array> {
  const label = new TextEncoder().encode(SEED_LABEL);
  const joined = new Uint8Array(label.length + signature.length);
  joined.set(label);
  joined.set(signature, label.length);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", joined));
}

async function derivedSeed(owner: string, sign: SignMessage): Promise<Uint8Array> {
  const message = depositKeyMessage(owner);
  let signature: Uint8Array;
  try {
    signature = await sign(message);
  } catch (error) {
    if (messageDeclined(error)) throw new DepositKeyDeclined();
    throw error;
  }
  if (
    signature.length !== SIGNATURE_BYTES ||
    !nacl.sign.detached.verify(message, signature, new PublicKey(owner).toBytes())
  ) {
    throw new Error(
      "Your wallet's signature for the deposit key did not verify. Nothing was sent.",
    );
  }
  return seedFromSignature(signature);
}

/** The key already stored on this browser, or null; it never makes one and never asks the wallet. */
export async function storedDepositKey(
  owner: string,
  seeds: SeedPort = browserSeeds,
): Promise<DepositKey | null> {
  const random = await seeds.load(randomName(owner));
  if (random) return { keypair: Keypair.fromSeed(random), derived: false };
  const derived = await seeds.load(derivedName(owner));
  return derived ? { keypair: Keypair.fromSeed(derived), derived: true } : null;
}

/** Every key stored on this browser for the owner, random first. It never asks the wallet. */
export async function storedDepositKeys(
  owner: string,
  seeds: SeedPort = browserSeeds,
): Promise<DepositKey[]> {
  const keys: DepositKey[] = [];
  const random = await seeds.load(randomName(owner));
  if (random) keys.push({ keypair: Keypair.fromSeed(random), derived: false });
  const derived = await seeds.load(derivedName(owner));
  if (derived) keys.push({ keypair: Keypair.fromSeed(derived), derived: true });
  return keys;
}

/** The derived key if this browser already holds it, else null; it never asks the wallet. */
export async function storedDerivedDepositKey(
  owner: string,
  seeds: SeedPort = browserSeeds,
): Promise<DepositKey | null> {
  return (await storedDepositKeys(owner, seeds)).find((key) => key.derived) ?? null;
}

/** The key stored on this browser, random or derived, whose public key is `wanted`; null when none is. It never asks the wallet. */
export async function storedKeyMatching(
  owner: string,
  wanted: string | undefined,
  seeds: SeedPort = browserSeeds,
): Promise<DepositKey | null> {
  if (wanted === undefined) return null;
  for (const [name, derived] of [
    [randomName(owner), false],
    [derivedName(owner), true],
  ] as const) {
    const seed = await seeds.load(name);
    if (!seed) continue;
    const keypair = Keypair.fromSeed(seed);
    if (keypair.publicKey.toBase58() === wanted) return { keypair, derived };
  }
  return null;
}

/** The stored key, or a fresh one that is not stored: for work that must never ask the wallet or leave a key that would shadow a derived one. */
export async function storedOrUnsavedDepositKey(
  owner: string,
  seeds: SeedPort = browserSeeds,
): Promise<DepositKey> {
  return (await storedDepositKey(owner, seeds)) ?? { keypair: Keypair.generate(), derived: false };
}

/**
 * The key made from the wallet's signature, stored before it is returned so
 * the wallet is asked once per browser. It is always the derived key, even
 * when a random one is also stored; that one is never replaced or removed.
 */
export async function deriveDepositKey(
  owner: string,
  sign: SignMessage,
  seeds: SeedPort = browserSeeds,
): Promise<DepositKey> {
  const kept = await seeds.load(derivedName(owner));
  if (kept) return { keypair: Keypair.fromSeed(kept), derived: true };
  const seed = await seeds.create(derivedName(owner), await derivedSeed(owner, sign));
  return { keypair: Keypair.fromSeed(seed), derived: true };
}

/**
 * The key a NEW deposit is made with: the derived key, from storage or made
 * from the wallet's signature, and committed to storage before it is returned
 * so no transfer ever begins with a key that a reload could lose. It is kept
 * the way the order seed is, wrapped under a key the browser cannot export,
 * and it lasts: the rollup accounts it needs are made once, on the first
 * deposit. A wallet that is asked and declines makes no key. A wallet that
 * cannot sign, fails to sign for any other reason or returns a signature that
 * does not verify uses the random key stored here, or gets a new one, flagged
 * `fellBack`, as before keys were derived. A stored random key is never
 * removed: it still finishes its own records.
 */
export async function loadOrCreateDepositKey(
  owner: string,
  sign?: SignMessage,
  seeds: SeedPort = browserSeeds,
): Promise<DepositKey> {
  const derived = await storedDerivedDepositKey(owner, seeds);
  if (derived) return derived;
  if (sign) {
    try {
      return await deriveDepositKey(owner, sign, seeds);
    } catch (error) {
      if (error instanceof DepositKeyDeclined) throw error;
    }
  }
  const random = await seeds.load(randomName(owner));
  return {
    keypair: Keypair.fromSeed(random ?? (await seeds.create(randomName(owner)))),
    derived: false,
    fellBack: true,
  };
}
