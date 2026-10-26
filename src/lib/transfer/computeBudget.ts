import { ComputeBudgetProgram, type TransactionInstruction } from "@solana/web3.js";

/** Solana's default allowance per instruction, used because no measured consumption is on record. */
export const UNITS_PER_INSTRUCTION = 200_000;
/** The most compute units a transaction may ask for. */
export const MAX_COMPUTE_UNITS = 1_400_000;
/** What the owner pays per compute unit, in micro-lamports, on top of the base fee. */
export const MICRO_LAMPORTS_PER_UNIT = 50_000;

/** The compute unit limit for a transaction of `count` instructions of its own, before the two budget instructions. */
export const computeUnitsFor = (count: number) =>
  Math.min(count * UNITS_PER_INSTRUCTION, MAX_COMPUTE_UNITS);

/** The most the priority fee can cost for a limit of `units`, in lamports. */
export const priorityLamportsFor = (units: number) =>
  Math.ceil((units * MICRO_LAMPORTS_PER_UNIT) / 1_000_000);

/** The most instructions each owner-paid Solana shape can carry: a sealed first deposit with the escrow and the permission, the token account's setup, the exit. */
const MOVE_INSTRUCTIONS = 7;
const SETUP_INSTRUCTIONS = 3;
const EXIT_INSTRUCTIONS = 4;

export const MAX_MOVE_PRIORITY_LAMPORTS = priorityLamportsFor(computeUnitsFor(MOVE_INSTRUCTIONS));
export const MAX_SETUP_PRIORITY_LAMPORTS = priorityLamportsFor(computeUnitsFor(SETUP_INSTRUCTIONS));
export const MAX_EXIT_PRIORITY_LAMPORTS = priorityLamportsFor(computeUnitsFor(EXIT_INSTRUCTIONS));

/**
 * `instructions` with the transaction's own compute budget in front: the unit
 * limit, then the unit price. A transaction that carries both is left alone by
 * the wallet, which adds a priority fee of its own only to one that has none.
 */
export function withComputeBudget(
  instructions: TransactionInstruction[],
): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitsFor(instructions.length) }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: MICRO_LAMPORTS_PER_UNIT }),
    ...instructions,
  ];
}
