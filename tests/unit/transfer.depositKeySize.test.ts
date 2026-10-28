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

describe("each step of the deposit through the deposit key fits one Solana transaction", () => {
  it("the wallet's payment to the key, with the key's token account to make and SOL to send", () => {
    const instructions = withComputeBudget(
      fundKeyInstructions({
        owner,
        key,
        mint,
        decimals: 6,
        atoms: 2_500_000n,
        lamports: 30_000_000,
      }),
    );
    expect(sizeOf(instructions)).toBeLessThanOrEqual(PACKET_LIMIT);
  });

  for (const sealed of [false, true]) {
    for (const first of [true, false]) {
      for (const vaultMissing of first ? [true, false] : [false]) {
        it(`the key's move, ${sealed ? "sealed" : "open"} custody, ${first ? "first" : "later"} deposit, escrow ${vaultMissing ? "missing" : "present"}`, async () => {
          const instructions = withComputeBudget(
            await moveKeyInstructions({
              key,
              mint,
              validator,
              atoms: 2_500_000n,
              sealed,
              first,
              vaultMissing,
              shuttleId: 7,
            }),
          );
          const transaction = new Transaction({
            feePayer: key,
            blockhash: PublicKey.default.toBase58(),
            lastValidBlockHeight: 1,
          }).add(...instructions);
          expect(
            transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).length,
          ).toBeLessThanOrEqual(PACKET_LIMIT);
        });
      }
    }
  }
});
