import { ComputeBudgetProgram, TransactionInstruction } from "@solana/web3.js";

/** Solana's default allowance per instruction, used because no measured consumption is on record. */
export const UNITS_PER_INSTRUCTION = 200_000;
/** The most compute units a transaction may ask for. */
export const MAX_COMPUTE_UNITS = 1_400_000;
/** What the owner pays per compute unit, in micro-lamports, on top of the base fee: the least a transfer pays, and the price used when the recent fees cannot be read. */
export const MICRO_LAMPORTS_PER_UNIT = 50_000;
/** The most the owner pays per compute unit however high recent fees run, in micro-lamports. */
export const MAX_MICRO_LAMPORTS_PER_UNIT = 200_000;
/** Which share of the recent fees the price follows: it beats this share of the transactions that wrote the same accounts. */
const FEE_PERCENTILE = 75;

/** The compute unit limit for a transaction of `count` instructions of its own, before the two budget instructions. */
export const computeUnitsFor = (count: number) =>
  Math.min(count * UNITS_PER_INSTRUCTION, MAX_COMPUTE_UNITS);

/** The most the priority fee can cost for a limit of `units`, in lamports. */
export const priorityLamportsFor = (units: number) =>
  Math.ceil((units * MAX_MICRO_LAMPORTS_PER_UNIT) / 1_000_000);

/** What each signature of a transaction costs, in lamports, before any priority fee. */
export const BASE_FEE_LAMPORTS = 5_000;

/** The most instructions each Solana shape can carry: the wallet's funding of the deposit key, the key's sealed first move with the escrow and the permission, the token account's setup, the exit. */
const FUND_INSTRUCTIONS = 3;
const MOVE_INSTRUCTIONS = 7;
const SETUP_INSTRUCTIONS = 3;
const EXIT_INSTRUCTIONS = 4;

/** The most a key-signed transaction of up to two instructions of its own (the payment back to the wallet, with the making of the wallet's token account) costs in fees at the dearest priority: what the deposit key keeps for a later payment back to the wallet, and more than a sweep of its SOL costs. */
export const MAX_KEY_TRANSFER_FEE_LAMPORTS =
  BASE_FEE_LAMPORTS + priorityLamportsFor(computeUnitsFor(2));
/** The least SOL worth a transaction to send the owner back from the deposit key. */
export const SWEEP_MIN_LAMPORTS = 100_000;

export const MAX_FUND_PRIORITY_LAMPORTS = priorityLamportsFor(computeUnitsFor(FUND_INSTRUCTIONS));
export const MAX_MOVE_PRIORITY_LAMPORTS = priorityLamportsFor(computeUnitsFor(MOVE_INSTRUCTIONS));
export const MAX_SETUP_PRIORITY_LAMPORTS = priorityLamportsFor(computeUnitsFor(SETUP_INSTRUCTIONS));
export const MAX_EXIT_PRIORITY_LAMPORTS = priorityLamportsFor(computeUnitsFor(EXIT_INSTRUCTIONS));

/** What the exit's steps on Solana cost their fee payer, in lamports: the transaction fee and the rent of the accounts the token program makes, and the priority fee of the token account's setup and of the exit. */
export const SOLANA_EXIT_LAMPORTS =
  10_000_000 + MAX_SETUP_PRIORITY_LAMPORTS + MAX_EXIT_PRIORITY_LAMPORTS;
/** The most a deposit costs the owner: the move into the rollup also pays the balance account's rent and the mint's escrow account, so three times the exit's, the rent of the deposit key's token account on its first deposit, and the priority fees of the wallet's funding and of the key's move (the deposit into the seat is a rollup send and has none). The owner pays it all, the key's share as SOL sent to the key. */
export const ROUND_TRIP_LAMPORTS =
  35_000_000 + MAX_FUND_PRIORITY_LAMPORTS + MAX_MOVE_PRIORITY_LAMPORTS;

/** The fewest compute units a measured limit is set to, so a small simulated figure never starves the transaction. */
export const MIN_COMPUTE_UNITS = 50_000;
/** The margin added to the units a simulation consumed, as a percentage. */
const SIMULATED_UNITS_MARGIN_PERCENT = 110;

/**
 * The compute unit limit for `count` instructions of its own, given the units
 * the simulation consumed: that figure plus 10%, never below the floor and
 * never above the default allowance. Without a usable figure it is the default.
 */
export function computeUnitsAfterSimulation(count: number, consumed: number | undefined): number {
  const allowance = computeUnitsFor(count);
  if (consumed === undefined || !Number.isSafeInteger(consumed) || consumed <= 0) return allowance;
  const measured = Math.ceil((consumed * SIMULATED_UNITS_MARGIN_PERCENT) / 100);
  return Math.min(Math.max(measured, MIN_COMPUTE_UNITS), allowance);
}

/** The most account data bytes a transaction may ask to load: the protocol maximum, 64 MiB. */
export const MAX_LOADED_ACCOUNTS_DATA_BYTES = 67_108_864;
/** The fewest bytes a measured loaded-accounts limit is set to, so a small simulated figure never starves the transaction. */
export const MIN_LOADED_ACCOUNTS_DATA_BYTES = 131_072;
/** The limit when the simulation reports no figure: 16 MiB, far above what any of these shapes loads (a few programs and token accounts), and a fraction of the 64 MiB default, so the limit is still explicit and cannot starve the transaction. */
export const FALLBACK_LOADED_ACCOUNTS_DATA_BYTES = 16_777_216;
/** The margin added to the bytes a simulation loaded, as a percentage: accounts can grow between the simulation and the landing. */
const SIMULATED_BYTES_MARGIN_PERCENT = 125;

/**
 * The loaded-accounts data size limit, given the bytes the simulation loaded:
 * that figure plus 25%, never below the floor and never above the protocol
 * maximum. Without a usable figure it is the fallback.
 */
export function loadedAccountsDataBytesAfterSimulation(loaded: number | undefined): number {
  if (loaded === undefined || !Number.isSafeInteger(loaded) || loaded <= 0) {
    return FALLBACK_LOADED_ACCOUNTS_DATA_BYTES;
  }
  const measured = Math.ceil((loaded * SIMULATED_BYTES_MARGIN_PERCENT) / 100);
  return Math.min(
    Math.max(measured, MIN_LOADED_ACCOUNTS_DATA_BYTES),
    MAX_LOADED_ACCOUNTS_DATA_BYTES,
  );
}

const SET_COMPUTE_UNIT_LIMIT = 2;
const SET_COMPUTE_UNIT_PRICE = 3;
const SET_LOADED_ACCOUNTS_DATA_SIZE_LIMIT = 4;

/** The instruction that caps the account data bytes a transaction loads at `bytes`; web3.js 1.x has no helper for it. */
function setLoadedAccountsDataSizeLimit(bytes: number): TransactionInstruction {
  const data = Buffer.alloc(5);
  data[0] = SET_LOADED_ACCOUNTS_DATA_SIZE_LIMIT;
  data.writeUInt32LE(bytes, 1);
  return new TransactionInstruction({ programId: ComputeBudgetProgram.programId, keys: [], data });
}

/**
 * The price per compute unit that follows the recent fees paid by transactions
 * writing the same accounts: the 75th percentile of `fees`, never below the
 * fixed price and never above the cap. Without any fee to go by it is the
 * fixed price.
 */
export function microLamportsFromFees(fees: number[] | undefined): number {
  const usable = (fees ?? []).filter((fee) => Number.isFinite(fee) && fee >= 0);
  if (usable.length === 0) return MICRO_LAMPORTS_PER_UNIT;
  const sorted = [...usable].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.ceil((sorted.length * FEE_PERCENTILE) / 100) - 1);
  return Math.min(
    Math.max(Math.ceil(sorted[at]), MICRO_LAMPORTS_PER_UNIT),
    MAX_MICRO_LAMPORTS_PER_UNIT,
  );
}

/**
 * `instructions` with the transaction's own compute budget in front: the unit
 * limit (`units`, by default the allowance for their count), then the unit
 * price (`microLamports`, by default the fixed price), then, when
 * `loadedBytes` is given, the loaded-accounts data size limit. A transaction
 * that carries both is left alone by the wallet, which adds a priority fee of
 * its own only to one that has none.
 */
export function withComputeBudget(
  instructions: TransactionInstruction[],
  units: number = computeUnitsFor(instructions.length),
  microLamports: number = MICRO_LAMPORTS_PER_UNIT,
  loadedBytes?: number,
): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    ...(loadedBytes === undefined ? [] : [setLoadedAccountsDataSizeLimit(loadedBytes)]),
    ...instructions,
  ];
}

function budgetData(
  instruction: TransactionInstruction | undefined,
  discriminator: number,
  length: number,
) {
  if (!instruction || !instruction.programId.equals(ComputeBudgetProgram.programId)) return null;
  const data = Buffer.from(instruction.data);
  return instruction.keys.length === 0 && data.length === length && data[0] === discriminator
    ? data
    : null;
}

/** The unit limit a `setComputeUnitLimit` instruction carries, or null when it is anything else. */
export function computeUnitLimitOf(instruction: TransactionInstruction | undefined): number | null {
  return budgetData(instruction, SET_COMPUTE_UNIT_LIMIT, 5)?.readUInt32LE(1) ?? null;
}

/** The micro-lamports per unit a `setComputeUnitPrice` instruction carries, or null when it is anything else. */
export function computeUnitPriceOf(instruction: TransactionInstruction | undefined): number | null {
  const data = budgetData(instruction, SET_COMPUTE_UNIT_PRICE, 9);
  return data === null ? null : Number(data.readBigUInt64LE(1));
}

/** The byte limit a `setLoadedAccountsDataSizeLimit` instruction carries, or null when it is anything else. */
export function loadedAccountsDataLimitOf(
  instruction: TransactionInstruction | undefined,
): number | null {
  return budgetData(instruction, SET_LOADED_ACCOUNTS_DATA_SIZE_LIMIT, 5)?.readUInt32LE(1) ?? null;
}
