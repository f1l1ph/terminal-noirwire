import { Keypair } from "@solana/web3.js";
import { createOrderSeed, loadOrderSeed } from "../rollup/orderSeedStore";

/** Where seeds are kept: one per name, written durably before it is returned. */
export interface SeedPort {
  load(name: string): Promise<Uint8Array | null>;
  create(name: string): Promise<Uint8Array>;
}

const browserSeeds: SeedPort = { load: loadOrderSeed, create: createOrderSeed };

const nameFor = (owner: string) => `deposit-key:${owner}`;

/**
 * The owner's deposit key on this browser: the stored one, or a new one that
 * is committed to storage before it is returned, so no wallet prompt and no
 * transfer ever begins with a key that a reload could lose. It is kept the way
 * the order seed is, wrapped under a key the browser cannot export, and it
 * lasts: the rollup accounts it needs are made once, on the first deposit.
 */
export async function loadOrCreateDepositKey(
  owner: string,
  seeds: SeedPort = browserSeeds,
): Promise<Keypair> {
  const stored = await seeds.load(nameFor(owner));
  return Keypair.fromSeed(stored ?? (await seeds.create(nameFor(owner))));
}
