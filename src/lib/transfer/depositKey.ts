import {
  delegateEataPermissionIx,
  delegateSpl,
  deriveEphemeralAta,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  associatedTokenAddress,
  createAssociatedTokenAccountIdempotentIx,
  transferCheckedIx,
} from "./tokenAccounts";

/** The deposit key's token account, one address on Solana and in the rollup. */
export const depositKeyAccount = (key: PublicKey, mint: PublicKey) =>
  associatedTokenAddress(key, mint);

/** The deposit key's balance account, the one the token program delegates to the rollup. */
export const depositKeyBalance = (key: PublicKey, mint: PublicKey) =>
  deriveEphemeralAta(key, mint)[0];

/**
 * The first half of the move: the owner makes the deposit key's token account
 * if it is missing and pays `atoms` into it from the owner's own.
 */
export function fundKeyInstructions(parts: {
  owner: PublicKey;
  key: PublicKey;
  mint: PublicKey;
  decimals: number;
  atoms: bigint;
}): TransactionInstruction[] {
  const { owner, key, mint, decimals, atoms } = parts;
  const account = depositKeyAccount(key, mint);
  return [
    createAssociatedTokenAccountIdempotentIx(owner, account, key, mint),
    transferCheckedIx(associatedTokenAddress(owner, mint), mint, account, owner, atoms, decimals),
  ];
}

/**
 * The second half: the deposit key's `atoms` go into the rollup as the key's
 * own balance, paid for by the owner, with the key as the one authority over
 * its tokens. A private balance also gets its permission on the key's first
 * move.
 */
export async function moveKeyInstructions(parts: {
  owner: PublicKey;
  key: PublicKey;
  mint: PublicKey;
  validator: PublicKey;
  atoms: bigint;
  sealed: boolean;
  /** Whether the key's balance account does not exist yet. */
  first: boolean;
  vaultMissing: boolean;
  shuttleId?: number;
}): Promise<TransactionInstruction[]> {
  const { owner, key, mint, validator, atoms, sealed, first, vaultMissing, shuttleId } = parts;
  const instructions = await delegateSpl(key, mint, atoms, {
    validator,
    idempotent: !first,
    payer: owner,
    initVaultIfMissing: vaultMissing,
    private: sealed,
    shuttleId,
  });
  if (sealed && first) {
    instructions.push(delegateEataPermissionIx(owner, depositKeyBalance(key, mint), validator));
  }
  return instructions;
}
