import type { PublicKey, Transaction } from "@solana/web3.js";
import nacl from "tweetnacl";

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

const plural = (count: number) => `${count} instruction${count === 1 ? "" : "s"}`;

/** Programs of the instructions in `after` that `before` does not account for, one entry per instruction. */
function programsOnlyIn(before: Transaction, after: Transaction): string[] {
  const remaining = before.instructions.map((instruction) => instruction.programId.toBase58());
  const extra: string[] = [];
  for (const instruction of after.instructions) {
    const program = instruction.programId.toBase58();
    const at = remaining.indexOf(program);
    if (at === -1) extra.push(program);
    else remaining.splice(at, 1);
  }
  return extra;
}

/** In plain words, what the signer did to the message. Program ids and counts only: nothing secret. */
function describeChange(built: Transaction, signed: Transaction): string {
  if (built.recentBlockhash !== signed.recentBlockhash) return "it changed the recent blockhash";
  const added = signed.instructions.length - built.instructions.length;
  if (added > 0) {
    const programs = [...new Set(programsOnlyIn(built, signed))];
    return `it added ${plural(added)}${programs.length ? `, from programs ${programs.join(", ")}` : ""}`;
  }
  if (added < 0) {
    const programs = [...new Set(programsOnlyIn(signed, built))];
    return `it removed ${plural(-added)}${programs.length ? `, from programs ${programs.join(", ")}` : ""}`;
  }
  const at = signed.instructions.findIndex((instruction, index) => {
    const original = built.instructions[index];
    return (
      !instruction.programId.equals(original.programId) ||
      !instruction.data.equals(original.data) ||
      instruction.keys.length !== original.keys.length ||
      instruction.keys.some(
        (key, i) =>
          !key.pubkey.equals(original.keys[i].pubkey) ||
          key.isSigner !== original.keys[i].isSigner ||
          key.isWritable !== original.keys[i].isWritable,
      )
    );
  });
  return at === -1
    ? "it changed how the transaction's accounts are listed"
    : `it changed instruction ${at + 1}, which runs program ${signed.instructions[at].programId.toBase58()}`;
}

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
    return "your wallet changed the transaction (it changed the fee payer)";
  }
  let message: Uint8Array;
  try {
    message = signed.serializeMessage();
    if (!sameBytes(message, builtMessage)) {
      return `your wallet changed the transaction (${describeChange(built, signed)})`;
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
      return `your wallet removed or changed the signature already on the transaction from ${entry.publicKey.toBase58()}`;
    }
  }
  for (const entry of signed.signatures) {
    if (!entry.signature || entry.publicKey.equals(owner)) continue;
    const before = built.signatures.find((each) => each.publicKey.equals(entry.publicKey));
    if (!before?.signature || !sameBytes(before.signature, entry.signature)) {
      return `your wallet added a signature from ${entry.publicKey.toBase58()} that was not expected`;
    }
  }
  return null;
}
