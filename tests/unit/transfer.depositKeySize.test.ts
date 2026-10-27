import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { withComputeBudget } from "@/lib/transfer/computeBudget";
import { fundKeyInstructions, moveKeyInstructions } from "@/lib/transfer/depositKey";

const PACKET_LIMIT = 1_232;
const owner = Keypair.generate().publicKey;
const key = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const validator = Keypair.generate().publicKey;

const sizeOf = (instructions: Parameters<Transaction["add"]>) =>
  new Transaction({
    feePayer: owner,
    blockhash: PublicKey.default.toBase58(),
    lastValidBlockHeight: 1,
  })
    .add(...instructions)
    .serialize({ requireAllSignatures: false, verifySignatures: false }).length;

describe("the deposit key's move fits one Solana transaction", () => {
  for (const sealed of [false, true]) {
    for (const first of [true, false]) {
      for (const vaultMissing of first ? [true, false] : [false]) {
        it(`${sealed ? "sealed" : "open"} custody, ${first ? "first" : "later"} deposit, escrow ${vaultMissing ? "missing" : "present"}`, async () => {
          const parts = { owner, key, mint, validator, atoms: 2_500_000n, sealed, first };
          const instructions = withComputeBudget([
            ...fundKeyInstructions({ ...parts, decimals: 6 }),
            ...(await moveKeyInstructions({ ...parts, vaultMissing, shuttleId: 7 })),
          ]);
          expect(sizeOf(instructions)).toBeLessThanOrEqual(PACKET_LIMIT);
        });
      }
    }
  }
});
