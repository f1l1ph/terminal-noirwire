import "../bufferBigInt";
import {
  EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
  delegateEataPermissionIx,
  delegateEphemeralAtaIx,
  delegateSpl,
  deriveEphemeralAta,
  initEphemeralAtaIx,
  withdrawSpl,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  PublicKey,
  SystemProgram,
  type Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { programInstructions, type CustodyToken } from "../rollup/sdk";
import {
  MAX_MICRO_LAMPORTS_PER_UNIT,
  MICRO_LAMPORTS_PER_UNIT,
  MIN_COMPUTE_UNITS,
  computeUnitLimitOf,
  computeUnitPriceOf,
  withComputeBudget,
} from "./computeBudget";
import {
  depositKeyAccount,
  fundKeyInstructions,
  moveKeyInstructions,
  returnKeyInstructions,
} from "./depositKey";
import { associatedTokenAddress, createAssociatedTokenAccountIdempotentIx } from "./tokenAccounts";

/** What the app pins: the order book program, the quote token and the rollup validator. */
export interface TransferPins {
  programId: PublicKey;
  mint: PublicKey;
  validator: PublicKey;
}

/** Refuses pins that are missing, not keys, the empty key, or the same key twice. */
export function validatedPins(pins: TransferPins): TransferPins {
  const keys = [pins.programId, pins.mint, pins.validator];
  if (keys.some((key) => !(key instanceof PublicKey) || key.equals(PublicKey.default))) {
    throw new Error("The transfer pins must be three public keys, none of them empty");
  }
  if (new Set(keys.map((key) => key.toBase58())).size !== keys.length) {
    throw new Error("The transfer pins must be three different keys");
  }
  return pins;
}

/** The one transaction a flow means to sign, with the amount it asked for. */
export type TransferShape =
  /** The token program's move of the wallet's tokens into the rollup, as a private balance when the custody is sealed. */
  | { kind: "move"; atoms: bigint; sealed: boolean }
  /** The token program's withdrawal from the rollup to the wallet. */
  | { kind: "exit"; atoms: bigint }
  /** Making the owner's rollup token account. */
  | { kind: "setup" }
  /** The order book's collateral deposit. */
  | { kind: "seat-deposit"; atoms: bigint }
  /** The owner's tokens paid to the deposit key's token account, with `lamports` of SOL (none when 0) for the key's own fees and rent: the one transaction the wallet signs, with the owner its only signer. */
  | { kind: "key-fund"; atoms: bigint; key: PublicKey; decimals: number; lamports: number }
  /** The deposit key's tokens moved into the rollup as the key's own balance, paid and signed by the key alone. */
  | { kind: "key-move"; atoms: bigint; sealed: boolean; key: PublicKey }
  /** The deposit key's tokens paid back to the owner's token account, signed by the key alone. */
  | { kind: "key-return"; atoms: bigint; key: PublicKey; decimals: number }
  /** The deposit key's spare SOL paid to the owner, one system transfer and nothing else, signed by the key alone. */
  | { kind: "key-sweep"; key: PublicKey; lamports: number }
  /** The order book's collateral deposit out of the deposit key's balance into the owner's account, paid by the key. */
  | { kind: "key-deposit"; atoms: bigint; key: PublicKey }
  /** The order book's collateral withdrawal, naming every perp market. */
  | { kind: "seat-withdraw"; atoms: bigint; marketIds: number[] };

export interface ShapeContext {
  pins: TransferPins;
  owner: PublicKey;
  /** The collateral token as the exchange registered it: the pinned mint and its custody nonce. */
  token: CustodyToken;
}

const SHUTTLE_DELEGATE = 24;
const SHUTTLE_WITHDRAW = 26;

/** The shuttle number a transaction carries, which the token program's builders draw at random. */
function shuttleIdOf(transaction: Transaction): number | undefined {
  for (const instruction of transaction.instructions) {
    const data = Buffer.from(instruction.data);
    if (
      instruction.programId.equals(EPHEMERAL_SPL_TOKEN_PROGRAM_ID) &&
      (data.length === 45 || data.length === 13) &&
      (data[0] === SHUTTLE_DELEGATE || data[0] === SHUTTLE_WITHDRAW)
    ) {
      return data.readUInt32LE(1);
    }
  }
  return undefined;
}

const sameInstruction = (a: TransactionInstruction, b: TransactionInstruction) =>
  a.programId.equals(b.programId) &&
  Buffer.from(a.data).equals(Buffer.from(b.data)) &&
  a.keys.length === b.keys.length &&
  a.keys.every(
    (key, at) =>
      key.pubkey.equals(b.keys[at].pubkey) &&
      key.isSigner === b.keys[at].isSigner &&
      key.isWritable === b.keys[at].isWritable,
  );

const sameList = (actual: TransactionInstruction[], expected: TransactionInstruction[]) =>
  actual.length === expected.length && actual.every((ix, at) => sameInstruction(ix, expected[at]));

/**
 * Whether `actual` is `expected`. The shapes sent to Solana lead with a unit
 * limit and a unit price that the flow sets from the simulation and the recent
 * fees, so there the limit may be any figure from the floor up to the expected
 * allowance and the price any figure from the fixed price up to the cap; every
 * other instruction must match exactly.
 */
function sameBudgeted(actual: TransactionInstruction[], expected: TransactionInstruction[]) {
  const allowance = computeUnitLimitOf(expected[0]);
  if (allowance === null) return sameList(actual, expected);
  const units = computeUnitLimitOf(actual[0]);
  const price = computeUnitPriceOf(actual[1]);
  return (
    units !== null &&
    units >= MIN_COMPUTE_UNITS &&
    units <= allowance &&
    price !== null &&
    price >= MICRO_LAMPORTS_PER_UNIT &&
    price <= MAX_MICRO_LAMPORTS_PER_UNIT &&
    sameList(actual.slice(2), expected.slice(2))
  );
}

/** Every transaction the shape can be, built fresh from the pins, the owner and the amount. */
async function expectedTransactions(
  { pins, owner, token }: ShapeContext,
  shape: TransferShape,
  shuttleId: number | undefined,
): Promise<TransactionInstruction[][]> {
  const balance = deriveEphemeralAta(owner, pins.mint)[0];
  const wallet = associatedTokenAddress(owner, pins.mint);
  const program = programInstructions(pins.programId);
  switch (shape.kind) {
    case "seat-deposit":
      return [[program.deposit(owner, wallet, token, owner, { collateral: true }, shape.atoms)]];
    case "key-deposit":
      return [
        [
          program.deposit(
            shape.key,
            depositKeyAccount(shape.key, pins.mint),
            token,
            owner,
            { collateral: true },
            shape.atoms,
          ),
        ],
      ];
    case "key-fund":
      return [
        withComputeBudget(
          fundKeyInstructions({
            owner,
            key: shape.key,
            mint: pins.mint,
            decimals: shape.decimals,
            atoms: shape.atoms,
            lamports: shape.lamports,
          }),
        ),
      ];
    case "key-move": {
      const variants = [true, false].flatMap((first) =>
        [true, false].map((vaultMissing) => ({ first, vaultMissing })),
      );
      return Promise.all(
        variants.map(async ({ first, vaultMissing }) =>
          withComputeBudget(
            await moveKeyInstructions({
              key: shape.key,
              mint: pins.mint,
              validator: pins.validator,
              atoms: shape.atoms,
              sealed: shape.sealed,
              first,
              vaultMissing,
              shuttleId,
            }),
          ),
        ),
      );
    }
    case "key-sweep":
      return [
        withComputeBudget([
          SystemProgram.transfer({
            fromPubkey: shape.key,
            toPubkey: owner,
            lamports: shape.lamports,
          }),
        ]),
      ];
    case "key-return":
      return [
        withComputeBudget(
          returnKeyInstructions({
            owner,
            key: shape.key,
            mint: pins.mint,
            decimals: shape.decimals,
            atoms: shape.atoms,
          }),
        ),
      ];
    case "seat-withdraw":
      return [
        [
          program.withdraw(
            owner,
            wallet,
            token,
            { collateral: true },
            shape.atoms,
            shape.marketIds,
          ),
        ],
      ];
    case "exit":
      return [
        withComputeBudget(
          await withdrawSpl(owner, pins.mint, shape.atoms, {
            validator: pins.validator,
            payer: owner,
            initAtasIfMissing: true,
            shuttleId,
          }),
        ),
      ];
    case "setup":
      return [
        withComputeBudget([
          createAssociatedTokenAccountIdempotentIx(owner, wallet, owner, pins.mint),
          initEphemeralAtaIx(balance, owner, pins.mint, owner),
          delegateEphemeralAtaIx(owner, balance, pins.validator),
        ]),
        withComputeBudget([delegateEphemeralAtaIx(owner, balance, pins.validator)]),
      ];
    case "move": {
      const variants = [false, true].flatMap((vault) => [
        { idempotent: false, vault },
        { idempotent: true, vault },
      ]);
      return Promise.all(
        variants.map(async ({ idempotent, vault }) => {
          const instructions = await delegateSpl(owner, pins.mint, shape.atoms, {
            validator: pins.validator,
            idempotent,
            payer: owner,
            initVaultIfMissing: vault,
            private: shape.sealed,
            shuttleId,
          });
          if (shape.sealed && !idempotent) {
            instructions.push(delegateEataPermissionIx(owner, balance, pins.validator));
          }
          return withComputeBudget(instructions);
        }),
      );
    }
  }
}

/**
 * Why `transaction` may not be signed, or null. Run on every transaction just
 * before it is signed: the owner pays (the deposit key, for the shapes the key
 * signs alone), and the instructions are
 * exactly the ordered list the flow means to send, rebuilt here from the pins,
 * the owner and the requested amount (the shapes sent to Solana lead with
 * a compute unit limit within the allowance of `withComputeBudget` and a unit
 * price between its fixed price and the cap, the rollup ones carry none), down to every account's signer and
 * writable flags and every byte of data. An extra, missing, reordered or
 * differently flagged instruction, a foreign program, mint or validator, and a
 * different amount all differ from it.
 */
export async function signableRefusal(
  context: ShapeContext,
  transaction: Transaction,
  shape: TransferShape,
): Promise<string | null> {
  const keyPays =
    shape.kind === "key-deposit" ||
    shape.kind === "key-move" ||
    shape.kind === "key-return" ||
    shape.kind === "key-sweep";
  const payer = keyPays ? shape.key : context.owner;
  if (!transaction.feePayer?.equals(payer)) {
    return keyPays ? "the deposit key is not the fee payer" : "the owner is not the fee payer";
  }
  const candidates = await expectedTransactions(context, shape, shuttleIdOf(transaction));
  return candidates.some((expected) => sameBudgeted(transaction.instructions, expected))
    ? null
    : `the instructions are not the expected ${shape.kind} transaction`;
}
