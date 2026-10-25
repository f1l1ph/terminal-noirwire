import { Transaction, type Keypair, type PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";

/** The one chain id a wallet is told about; a rollup transaction is signed with no chain at all. */
export type MainnetChain = "solana:mainnet";

/**
 * The port every owner signature goes through. The owner key may live in a
 * browser wallet that only signs (the terminal then sends what comes back)
 * or in this device's own keypair; callers see neither.
 */
export type OwnerSigner = {
  publicKey: PublicKey;
  /** The signature over exactly `message`. Throws when the signer cannot vouch for it. */
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  /**
   * `tx` signed by the owner. Pass `chain` only for a Solana mainnet
   * transaction; a rollup transaction is signed without one. What comes back
   * is the signer's word, not yet trusted: check it with `signedDiffers`.
   */
  signTransaction(tx: Transaction, chain?: MainnetChain): Promise<Transaction>;
};

/** Thrown when a signature comes back after the account it was asked of was switched or disconnected: the result is discarded. */
export class StaleSigner extends Error {
  constructor() {
    super("the wallet account changed while it was signing");
    this.name = "StaleSigner";
  }
}

/** An owner signer over a keypair held in this browser. */
export function keypairOwnerSigner(keypair: Keypair): OwnerSigner {
  return {
    publicKey: keypair.publicKey,
    async signMessage(message) {
      return nacl.sign.detached(message, keypair.secretKey);
    },
    async signTransaction(tx) {
      const copy = Transaction.from(
        tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
      );
      copy.partialSign(keypair);
      return copy;
    },
  };
}
