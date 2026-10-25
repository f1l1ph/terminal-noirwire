import type { PublicKey, Transaction } from "@solana/web3.js";
import nacl from "tweetnacl";

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

/**
 * Why `signed` is not the transaction that was built, or null when it is:
 * the same message byte for byte (instructions, accounts, fee payer,
 * blockhash), a valid owner signature over it, and no signature beyond the
 * owner's other than ones `built` already carried. A wallet that adds a
 * compute budget, a priority fee or a guard instruction of its own changes
 * the message, and the caller sends nothing.
 *
 * `builtMessage` is the message the caller serialized before handing `built`
 * to the signer, never re-read from `built` afterwards: a signer holding the
 * same object could have changed it. `signed` must be a different object.
 */
export function signedDiffers(
  built: Transaction,
  builtMessage: Uint8Array,
  signed: Transaction,
  owner: PublicKey,
): string | null {
  if (signed === built) return "the signer returned the very transaction it was given";
  if (!built.feePayer || !signed.feePayer?.equals(built.feePayer)) {
    return "the signer changed the fee payer";
  }
  let message: Uint8Array;
  try {
    message = signed.serializeMessage();
    if (!sameBytes(message, builtMessage)) {
      return "the signer changed the transaction it was given";
    }
  } catch {
    return "the signed transaction cannot be serialized";
  }
  const ownerEntry = signed.signatures.find((entry) => entry.publicKey.equals(owner));
  if (!ownerEntry?.signature) return "the owner's signature is missing";
  if (!nacl.sign.detached.verify(message, ownerEntry.signature, owner.toBytes())) {
    return "the owner's signature does not verify over the built transaction";
  }
  for (const entry of built.signatures) {
    if (!entry.signature) continue;
    const after = signed.signatures.find((each) => each.publicKey.equals(entry.publicKey));
    if (!after?.signature || !sameBytes(after.signature, entry.signature)) {
      return `the signature already from ${entry.publicKey.toBase58()} was removed or changed`;
    }
  }
  for (const entry of signed.signatures) {
    if (!entry.signature || entry.publicKey.equals(owner)) continue;
    const before = built.signatures.find((each) => each.publicKey.equals(entry.publicKey));
    if (!before?.signature || !sameBytes(before.signature, entry.signature)) {
      return `an unexpected signature from ${entry.publicKey.toBase58()} was added`;
    }
  }
  return null;
}
