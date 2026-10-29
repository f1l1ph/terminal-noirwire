import {
  MEMBER_SIZE,
  PERMISSION_SEED,
  encodeEphemeralAta,
  encodeGlobalVault,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import { PublicKey } from "@solana/web3.js";
import { BASE_FEE_LAMPORTS, MAX_MOVE_PRIORITY_LAMPORTS } from "./computeBudget";
import type { SolanaRpc } from "./solanaRpc";

/** What decides which accounts the deposit key's move creates. */
export interface KeyMoveParts {
  /** Whether the key's balance account does not exist yet. */
  first: boolean;
  /** Whether the mint's escrow does not exist yet. */
  vaultMissing: boolean;
  sealed: boolean;
}

/** The data size of the token program's token account. */
export const TOKEN_ACCOUNT_BYTES = 165;

const blank = PublicKey.default;
const EPHEMERAL_ATA_BYTES = encodeEphemeralAta({ owner: blank, mint: blank, amount: 0n }).length;
const VAULT_BYTES = encodeGlobalVault({ mint: blank }).length;
/** A permission with its one member: the discriminator, the bump, the account, the members' presence flag and count, and the member. */
const PERMISSION_BYTES = 1 + 1 + 32 + 1 + 4 + MEMBER_SIZE;
/** The delegation program's record of a delegated account: its discriminator, the authority, the owner, the slot, the lamports and the commit frequency. */
const DELEGATION_RECORD_BYTES = 8 + 32 + 32 + 8 + 8 + 8;
const PUBKEY_BYTES = 32;

/** The delegation program's metadata of a delegated account made from `seeds`: its discriminator, the update nonce, the undelegatable flag, the seeds with their lengths, and the rent payer. */
const delegationMetadataBytes = (seeds: number[]) =>
  8 + 8 + 1 + 4 + seeds.reduce((sum, length) => sum + 4 + length, 0) + PUBKEY_BYTES;

/**
 * The accounts one delegation to the rollup makes, by data size: the delegation
 * program's buffer holding a copy of the account, its record and its metadata.
 * The buffer is given back when the delegation completes, and is counted
 * anyway, so the figure is the most the key can need.
 */
const delegationBytes = (accountBytes: number, seeds: number[]) => [
  accountBytes,
  DELEGATION_RECORD_BYTES,
  delegationMetadataBytes(seeds),
];

/**
 * The data size of every account the deposit key's move creates. A first move
 * makes the key's balance account and delegates it, with its permission when
 * the custody is sealed; a missing escrow adds the mint's vault, its balance
 * account and its token account. A later move makes a shuttle, but the token
 * program pays that account's rent from its own rent account and charges the
 * key `SHUTTLE_CHARGE_LAMPORTS` instead, so it makes no account at the key's
 * cost.
 */
export function keyMoveAccountBytes({ first, vaultMissing, sealed }: KeyMoveParts): number[] {
  const accounts: number[] = [];
  if (vaultMissing) accounts.push(VAULT_BYTES, EPHEMERAL_ATA_BYTES, TOKEN_ACCOUNT_BYTES);
  if (first) {
    accounts.push(EPHEMERAL_ATA_BYTES, ...delegationBytes(EPHEMERAL_ATA_BYTES, [32, 32]));
    if (sealed) {
      accounts.push(
        PERMISSION_BYTES,
        ...delegationBytes(PERMISSION_BYTES, [PERMISSION_SEED.length, 32]),
      );
    }
  }
  return accounts;
}

/** What the token program takes from the key for the shuttle of a later move, measured on devnet at 500000 lamports (the shuttle's rent came from the program's own rent account). */
const SHUTTLE_CHARGE_MEASURED_LAMPORTS = 500_000;
/** Kept on top of the measured charge, so a small change in it does not stop the move. */
const SHUTTLE_CHARGE_MARGIN_LAMPORTS = 100_000;
export const SHUTTLE_CHARGE_LAMPORTS =
  SHUTTLE_CHARGE_MEASURED_LAMPORTS + SHUTTLE_CHARGE_MARGIN_LAMPORTS;

/** The SOL the deposit key's move spends: the rent of the accounts it makes (or the shuttle's charge for a later move) and its fee at the dearest priority, in lamports. */
export async function keyMoveLamports(
  rpc: Pick<SolanaRpc, "getMinimumBalanceForRentExemption">,
  parts: KeyMoveParts,
): Promise<number> {
  const rents = await Promise.all(
    keyMoveAccountBytes(parts).map((bytes) => rpc.getMinimumBalanceForRentExemption(bytes)),
  );
  return (
    rents.reduce((sum, rent) => sum + rent, 0) +
    (parts.first ? 0 : SHUTTLE_CHARGE_LAMPORTS) +
    BASE_FEE_LAMPORTS +
    MAX_MOVE_PRIORITY_LAMPORTS
  );
}

/**
 * What the wallet must send the deposit key so it can make its move: what the
 * move spends and what the key must keep afterwards (the rent of its own empty
 * account, which the network requires of a paying account that is not
 * emptied), less what the key holds, never below 0.
 */
export async function keyShortfallLamports(
  rpc: Pick<SolanaRpc, "getMinimumBalanceForRentExemption" | "getBalance">,
  deposit: PublicKey,
  parts: KeyMoveParts,
): Promise<number> {
  const [spent, kept, held] = await Promise.all([
    keyMoveLamports(rpc, parts),
    rpc.getMinimumBalanceForRentExemption(0),
    rpc.getBalance(deposit, "confirmed"),
  ]);
  return Math.max(0, spent + kept - held);
}
