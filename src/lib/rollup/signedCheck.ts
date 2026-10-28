import {
  ComputeBudgetProgram,
  Message,
  Transaction,
  type PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import { computeUnitLimitOf, computeUnitsFor } from "../transfer/computeBudget";

/** The program a wallet appends its own assertions with: they only check account state after execution and fail the transaction if it differs, and move no funds. */
export const WALLET_ASSERTION_PROGRAM = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

/** An instruction as the message lists it: program, data and the ordered account keys, without per-instruction flags (a message has only one status per account). */
const listed = (message: Message, instruction: Message["instructions"][number]) =>
  [
    message.accountKeys[instruction.programIdIndex].toBase58(),
    instruction.data,
    ...instruction.accounts.map((index) => message.accountKeys[index].toBase58()),
  ].join("|");

const requiredSigners = (message: Message) =>
  message.accountKeys
    .slice(0, message.header.numRequiredSignatures)
    .map((key) => key.toBase58())
    .sort();

/**
 * Whether `theirs` is `ours`, a compute unit limit, raised and no higher than
 * `cap`. A wallet raises it to pay for the assertions it appends.
 */
function raisedUnitLimit(
  ours: TransactionInstruction,
  theirs: TransactionInstruction,
  cap: number,
): boolean {
  const was = computeUnitLimitOf(ours);
  const now = computeUnitLimitOf(theirs);
  return was !== null && now !== null && now > was && now <= cap;
}

/**
 * Whether `signedMessage` is `builtMessage` plus instructions of the wallet's
 * assertion program and nothing else, judged on the message, where an
 * account has one signer and one writable status for every instruction:
 * - the same fee payer, blockhash and required signers (count and keys);
 * - each of our instructions in our order, with the same program, data and
 *   account keys (the additions may sit between them or around them), except
 *   that alongside at least one assertion our compute unit limit may be
 *   raised, up to the allowance for our instruction count: the priority fee
 *   the transfer's SOL check already reserves, at our unchanged price;
 * - every account of ours keeps exactly its signer and writable status;
 * - an account the wallet introduced is never a signer;
 * - every other instruction is of the assertion program, which may name our
 *   accounts: it cannot use their signer status to move funds, and that
 *   status is unchanged.
 */
function onlyWalletAssertionsAdded(builtMessage: Uint8Array, signedMessage: Uint8Array): boolean {
  let before: Message;
  let after: Message;
  try {
    before = Message.from(builtMessage);
    after = Message.from(signedMessage);
  } catch {
    return false;
  }
  if (
    !before.accountKeys[0].equals(after.accountKeys[0]) ||
    before.recentBlockhash !== after.recentBlockhash ||
    before.header.numRequiredSignatures !== after.header.numRequiredSignatures ||
    requiredSigners(before).join() !== requiredSigners(after).join()
  ) {
    return false;
  }
  const ours = new Map(before.accountKeys.map((key, index) => [key.toBase58(), index]));
  for (const [index, key] of after.accountKeys.entries()) {
    const was = ours.get(key.toBase58());
    if (was === undefined) {
      if (after.isAccountSigner(index)) return false;
    } else if (
      before.isAccountSigner(was) !== after.isAccountSigner(index) ||
      before.isAccountWritable(was) !== after.isAccountWritable(index)
    ) {
      return false;
    }
  }
  const mine = before.instructions.map((instruction) => listed(before, instruction));
  const ourInstructions = Transaction.populate(before).instructions;
  const theirInstructions = Transaction.populate(after).instructions;
  const unitCap = computeUnitsFor(
    ourInstructions.filter((each) => !each.programId.equals(ComputeBudgetProgram.programId)).length,
  );
  let next = 0;
  let assertions = 0;
  let raised = false;
  for (const [index, instruction] of after.instructions.entries()) {
    if (next < mine.length && listed(after, instruction) === mine[next]) {
      next += 1;
    } else if (
      next < mine.length &&
      raisedUnitLimit(ourInstructions[next], theirInstructions[index], unitCap)
    ) {
      raised = true;
      next += 1;
    } else if (
      after.accountKeys[instruction.programIdIndex].toBase58() === WALLET_ASSERTION_PROGRAM
    ) {
      assertions += 1;
    } else {
      return false;
    }
  }
  return next === mine.length && (!raised || assertions > 0);
}

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
 *
 * `allowWalletAssertions` is true only for a transaction sent to Solana
 * mainnet, where a wallet may append instructions of its assertion program
 * (`onlyWalletAssertionsAdded` says exactly what is tolerated). It is false
 * for the rollup, where that program does not exist and the instructions
 * would fail the transaction.
 */
export function signedDiffers(
  built: Transaction,
  builtMessage: Uint8Array,
  signed: Transaction,
  owner: PublicKey,
  allowWalletAssertions: boolean,
): string | null {
  if (signed === built) return "the signer returned the very transaction it was given";
  if (!built.feePayer || !signed.feePayer?.equals(built.feePayer)) {
    return "your wallet changed the transaction (it changed the fee payer)";
  }
  let message: Uint8Array;
  try {
    message = signed.serializeMessage();
    if (
      !sameBytes(message, builtMessage) &&
      !(allowWalletAssertions && onlyWalletAssertionsAdded(builtMessage, message))
    ) {
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
