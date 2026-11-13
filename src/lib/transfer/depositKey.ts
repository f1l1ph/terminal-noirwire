import {
  delegateEataPermissionIx,
  delegateSpl,
  deriveEphemeralAta,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { SystemProgram, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
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
 * The wallet's half of the move, the only part it signs: the owner makes the
 * deposit key's token account if it is missing, pays `atoms` into it from the
 * owner's own, and sends the key `lamports` of SOL (none when 0) for the rent
 * and fees of the key's own half. The owner is the only signer.
 */
export function fundKeyInstructions(parts: {
  owner: PublicKey;
  key: PublicKey;
  mint: PublicKey;
  decimals: number;
  atoms: bigint;
  lamports: number;
}): TransactionInstruction[] {
  const { owner, key, mint, decimals, atoms, lamports } = parts;
  const account = depositKeyAccount(key, mint);
  return [
    createAssociatedTokenAccountIdempotentIx(owner, account, key, mint),
    transferCheckedIx(associatedTokenAddress(owner, mint), mint, account, owner, atoms, decimals),
    ...(lamports > 0
      ? [SystemProgram.transfer({ fromPubkey: owner, toPubkey: key, lamports })]
      : []),
  ];
}

/**
 * The deposit key's half: its `atoms` go into the rollup as the key's own
 * balance, with the key as payer, as the one authority over its tokens and as
 * the only signer, so the wallet never sees it. A private balance also gets
 * its permission on the key's first move.
 */
export async function moveKeyInstructions(parts: {
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
  const { key, mint, validator, atoms, sealed, first, vaultMissing, shuttleId } = parts;
  const instructions = await delegateSpl(key, mint, atoms, {
    validator,
    idempotent: !first,
    payer: key,
    initVaultIfMissing: vaultMissing,
    private: sealed,
    shuttleId,
  });
  if (sealed && first) {
    instructions.push(delegateEataPermissionIx(key, depositKeyBalance(key, mint), validator));
  }
  return instructions;
}

/** The deposit key's payment of `atoms` of its own tokens back to the owner's token account, which it makes first if it was closed meanwhile: signed and paid by the key alone. */
export const returnKeyInstructions = (parts: {
  owner: PublicKey;
  key: PublicKey;
  mint: PublicKey;
  decimals: number;
  atoms: bigint;
}): TransactionInstruction[] => [
  createAssociatedTokenAccountIdempotentIx(
    parts.key,
    associatedTokenAddress(parts.owner, parts.mint),
    parts.owner,
    parts.mint,
  ),
  transferCheckedIx(
    depositKeyAccount(parts.key, parts.mint),
    parts.mint,
    associatedTokenAddress(parts.owner, parts.mint),
    parts.key,
    parts.atoms,
    parts.decimals,
  ),
];
