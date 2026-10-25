import { Connection } from "@solana/web3.js";
import type { OwnerSigner } from "../wallet/ownerSigner";
import { guardedOwnerSigner, rpcIdentity, type NetworkReads } from "./networkCheck";
import { MAINNET_PINS } from "./pins";

const guarded = new WeakSet<OwnerSigner>();

/**
 * The owner signer a mainnet build trades with: `connected` (the Wallet
 * Standard signer) wrapped so that, before every signature, the Solana RPC
 * must report the pinned genesis hash and the rollup the pinned validator.
 * Both reads are against the pinned values in code and the Solana RPC from
 * this build's environment, never from anything the service says. `reads` is
 * only for tests.
 */
export function mainnetOwnerSigner(
  connected: OwnerSigner,
  solanaRpcUrl: string,
  reads: NetworkReads = {
    solana: new Connection(solanaRpcUrl, "confirmed"),
    rollupIdentity: rpcIdentity(MAINNET_PINS.rollupRpcUrl),
  },
): OwnerSigner {
  const signer = guardedOwnerSigner(
    connected,
    { genesis: MAINNET_PINS.solanaGenesis, validator: MAINNET_PINS.validator },
    reads,
  );
  guarded.add(signer);
  return signer;
}

/** Whether `signer` was made by `mainnetOwnerSigner`. A mainnet session accepts no other. */
export const isMainnetOwnerSigner = (signer: OwnerSigner): boolean => guarded.has(signer);
