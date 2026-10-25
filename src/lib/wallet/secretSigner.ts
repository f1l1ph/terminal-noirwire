import { Keypair } from "@solana/web3.js";
import { refuseOnMainnet } from "../network";
import { deriveLegacyOrderSeed, deriveOrderSeed } from "../rollup/keys";
import { hexToBytes } from "./index";
import { keypairOwnerSigner, type OwnerSigner } from "./ownerSigner";

/** The order-key seeds a test build derives from the owner secret. */
export interface DerivedOrderSeeds {
  seed: Uint8Array;
  /** The earlier signature-based seed, kept only to recognise keys an older build installed. */
  legacySeed: Uint8Array;
}

/**
 * The only door from a wallet secret to a signer, for test builds. Every
 * path that reads a secret ends here, and every one refuses on a mainnet
 * build, where the owner signs in a wallet the page never sees into.
 */
export function ownerKeypairFrom(wallet: { secretKeyHex: string }): Keypair {
  refuseOnMainnet("Signing with a wallet secret held in the page");
  return Keypair.fromSecretKey(hexToBytes(wallet.secretKeyHex));
}

/** A signer over the built-in browser wallet's keypair, and the order seeds that keypair yields. */
export function secretOwner(wallet: { secretKeyHex: string }): {
  signer: OwnerSigner;
  derivedSeeds: DerivedOrderSeeds;
} {
  const keypair = ownerKeypairFrom(wallet);
  return {
    signer: keypairOwnerSigner(keypair),
    derivedSeeds: {
      seed: deriveOrderSeed(keypair),
      legacySeed: deriveLegacyOrderSeed(keypair),
    },
  };
}
