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
 * the custody is sealed; a later move makes a shuttle (its account, its
 * delegated balance and its wallet token account) that carries the tokens in;
 * a missing escrow adds the mint's vault, its balance account and its token
 * account.
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
  } else {
    accounts.push(
      EPHEMERAL_ATA_BYTES,
      EPHEMERAL_ATA_BYTES,
      TOKEN_ACCOUNT_BYTES,
      ...delegationBytes(EPHEMERAL_ATA_BYTES, [32, 32]),
    );
  }
  return accounts;
}

/** The SOL the deposit key's move needs to make its accounts and pay its fee at the dearest priority, in lamports. */
export async function keyMoveLamports(
  rpc: Pick<SolanaRpc, "getMinimumBalanceForRentExemption">,
  parts: KeyMoveParts,
): Promise<number> {
  const rents = await Promise.all(
    keyMoveAccountBytes(parts).map((bytes) => rpc.getMinimumBalanceForRentExemption(bytes)),
  );
  return (
    rents.reduce((sum, rent) => sum + rent, 0) + BASE_FEE_LAMPORTS + MAX_MOVE_PRIORITY_LAMPORTS
  );
}

/** What the wallet must send the deposit key so it can make its move: what the move needs less what the key holds, never below 0. */
export async function keyShortfallLamports(
  rpc: Pick<SolanaRpc, "getMinimumBalanceForRentExemption" | "getBalance">,
  deposit: PublicKey,
  parts: KeyMoveParts,
): Promise<number> {
  const [needed, held] = await Promise.all([
    keyMoveLamports(rpc, parts),
    rpc.getBalance(deposit, "confirmed"),
  ]);
  return Math.max(0, needed - held);
}
