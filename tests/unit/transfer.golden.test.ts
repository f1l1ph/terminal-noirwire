import { createHash } from "node:crypto";
import { delegateSpl, withdrawSpl } from "@magicblock-labs/ephemeral-rollups-sdk";
import { PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { signableRefusal, type TransferShape } from "@/lib/transfer/guard";
import {
  createAssociatedTokenAccountIdempotentIx,
  depositInstruction,
  walletAccount,
  withdrawInstruction,
} from "@/lib/transfer/operation";
import { makeWorld, type World } from "./transferWorld";

/*
 * Every expectation below is written out by hand from the sources named in the
 * comments, not built with the code under test, so these tests check meaning
 * and not only that the guard and the flows agree with each other.
 *
 * Token program accounts and data:
 *   node_modules/@magicblock-labs/ephemeral-rollups-sdk/lib/instructions/ephemeral-spl-token-program/ephemeralAta.js
 *   and lib/pda.js for the delegation addresses.
 * Order book accounts and data:
 *   node_modules/@noirwire/orderbook/dist/instructions.js (deposit, withdraw, custodyLeg, riskMetas),
 *   addresses.js and constants.js (seeds), bytes.js (the discriminator).
 */

const ESPL = new PublicKey("SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2");
const DELEGATION = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM = new PublicKey("11111111111111111111111111111111");
const COMPUTE_BUDGET = new PublicKey("ComputeBudget111111111111111111111111111111");

const ATOMS = 2_500_000n;
const SHUTTLE_ID = 42;

const meta = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({
  pubkey,
  isSigner,
  isWritable,
});
const signerWritable = (key: PublicKey) => meta(key, true, true);
const signer = (key: PublicKey) => meta(key, true, false);
const writable = (key: PublicKey) => meta(key, false, true);
const readonly = (key: PublicKey) => meta(key, false, false);

const pda = (seeds: Buffer[], program: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds, program)[0];
const u64 = (value: bigint) => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
};
const u32 = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};
const associated = (owner: PublicKey, mint: PublicKey) =>
  pda([owner.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()], ASSOCIATED);
const anchorDiscriminator = (name: string) =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

const instruction = (
  programId: PublicKey,
  keys: ReturnType<typeof meta>[],
  data: Buffer,
): TransactionInstruction => new TransactionInstruction({ programId, keys, data });

/**
 * The compute budget program's two instructions (data 2 then a u32 unit limit,
 * data 3 then a u64 price in micro-lamports) that lead a transaction sent to
 * Solana: 200,000 units for each instruction of its own, at 50,000 micro-lamports.
 */
const budgeted = (instructions: TransactionInstruction[]) => [
  instruction(
    COMPUTE_BUDGET,
    [],
    Buffer.concat([Buffer.from([2]), u32(200_000 * instructions.length)]),
  ),
  instruction(COMPUTE_BUDGET, [], Buffer.concat([Buffer.from([3]), u64(50_000n)])),
  ...instructions,
];

const written = (instructions: TransactionInstruction[]) =>
  instructions.map((ix) => ({
    program: ix.programId.toBase58(),
    keys: ix.keys.map((key) => [key.pubkey.toBase58(), key.isSigner, key.isWritable]),
    data: Buffer.from(ix.data).toString("hex"),
  }));

/** The addresses the token program derives for a balance (delegation addresses: lib/pda.js). */
const balanceAddresses = (account: PublicKey) => ({
  buffer: pda([Buffer.from("buffer"), account.toBuffer()], ESPL),
  record: pda([Buffer.from("delegation"), account.toBuffer()], DELEGATION),
  metadata: pda([Buffer.from("delegation-metadata"), account.toBuffer()], DELEGATION),
});

/** ephemeralAta.js initEphemeralAtaIx: data 0. */
const initBalance = (balance: PublicKey, owner: PublicKey, mint: PublicKey) =>
  instruction(
    ESPL,
    [writable(balance), signerWritable(owner), readonly(owner), readonly(mint), readonly(SYSTEM)],
    Buffer.from([0]),
  );

/** ephemeralAta.js delegateEphemeralAtaIx: data 4 then the validator. */
const delegateBalance = (owner: PublicKey, balance: PublicKey, validator: PublicKey) => {
  const { buffer, record, metadata } = balanceAddresses(balance);
  return instruction(
    ESPL,
    [
      signerWritable(owner),
      writable(balance),
      readonly(ESPL),
      writable(buffer),
      writable(record),
      writable(metadata),
      readonly(DELEGATION),
      readonly(SYSTEM),
    ],
    Buffer.concat([Buffer.from([4]), validator.toBuffer()]),
  );
};

/** The associated token program's idempotent create: data 1. */
const createAssociated = (
  payer: PublicKey,
  account: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
) =>
  instruction(
    ASSOCIATED,
    [
      signerWritable(payer),
      writable(account),
      readonly(owner),
      readonly(mint),
      readonly(SYSTEM),
      readonly(TOKEN),
    ],
    Buffer.from([1]),
  );

const txOf = (owner: PublicKey, instructions: TransactionInstruction[]) =>
  new Transaction({
    feePayer: owner,
    blockhash: PublicKey.default.toBase58(),
    lastValidBlockHeight: 1,
  }).add(...instructions);

const guardAccepts = async (
  world: World,
  instructions: TransactionInstruction[],
  shape: TransferShape,
) =>
  signableRefusal(
    { pins: world.pins, owner: world.keypair.publicKey, token: world.token },
    txOf(world.keypair.publicKey, instructions),
    shape,
  );

describe("golden transactions, written by hand", () => {
  it("setup: make the token account and the balance, and delegate it", async () => {
    const world = makeWorld();
    const owner = world.keypair.publicKey;
    const { mint, validator } = world.pins;
    const balance = pda([owner.toBuffer(), mint.toBuffer()], ESPL);
    const hand = [
      createAssociated(owner, associated(owner, mint), owner, mint),
      initBalance(balance, owner, mint),
      delegateBalance(owner, balance, validator),
    ];
    expect(await guardAccepts(world, budgeted(hand), { kind: "setup" })).toBeNull();
    const built = [
      createAssociatedTokenAccountIdempotentIx(owner, walletAccount(world.env), owner, mint),
      ...hand.slice(1),
    ];
    expect(written(hand)).toEqual(written(built));
  });

  it("move: a first deposit that also makes the mint's escrow, unsealed", async () => {
    const world = makeWorld();
    const owner = world.keypair.publicKey;
    const { mint, validator } = world.pins;
    const balance = pda([owner.toBuffer(), mint.toBuffer()], ESPL);
    const vault = pda([mint.toBuffer()], ESPL);
    const vaultBalance = pda([vault.toBuffer(), mint.toBuffer()], ESPL);
    const vaultAta = associated(vault, mint);
    const hand = [
      initBalance(balance, owner, mint),
      // ephemeralAta.js initVaultIx: data 1.
      instruction(
        ESPL,
        [
          writable(vault),
          signerWritable(owner),
          readonly(mint),
          writable(vaultBalance),
          writable(vaultAta),
          readonly(TOKEN),
          readonly(ASSOCIATED),
          readonly(SYSTEM),
        ],
        Buffer.from([1]),
      ),
      createAssociated(owner, vaultAta, vault, mint),
      // ephemeralAta.js transferToVaultIx: data 2 then the amount.
      instruction(
        ESPL,
        [
          writable(balance),
          readonly(vault),
          readonly(mint),
          writable(associated(owner, mint)),
          writable(vaultAta),
          signer(owner),
          readonly(TOKEN),
        ],
        Buffer.concat([Buffer.from([2]), u64(ATOMS)]),
      ),
      delegateBalance(owner, balance, validator),
    ];
    const shape = { kind: "move", atoms: ATOMS, sealed: false } as const;
    expect(await guardAccepts(world, budgeted(hand), shape)).toBeNull();
    const built = await delegateSpl(owner, mint, ATOMS, {
      validator,
      idempotent: false,
      payer: owner,
      initVaultIfMissing: true,
      private: false,
    });
    expect(written(hand)).toEqual(written(built));
  });

  it("exit: the token program's shuttle withdrawal of exactly the amount", async () => {
    const world = makeWorld();
    const owner = world.keypair.publicKey;
    const { mint, validator } = world.pins;
    const balance = pda([owner.toBuffer(), mint.toBuffer()], ESPL);
    const ownerAta = associated(owner, mint);
    const shuttle = pda([owner.toBuffer(), mint.toBuffer(), u32(SHUTTLE_ID)], ESPL);
    const shuttleAta = pda([shuttle.toBuffer(), mint.toBuffer()], ESPL);
    const shuttleWallet = associated(shuttle, mint);
    const shuttleAddresses = balanceAddresses(shuttleAta);
    const hand = [
      createAssociated(owner, ownerAta, owner, mint),
      initBalance(balance, owner, mint),
      delegateBalance(owner, balance, validator),
      // ephemeralAta.js withdrawThroughDelegatedShuttleWithMergeIx: data 26, shuttle id, amount, validator.
      instruction(
        ESPL,
        [
          signerWritable(owner),
          writable(pda([Buffer.from("rent")], ESPL)),
          writable(shuttle),
          writable(shuttleAta),
          writable(shuttleWallet),
          signer(owner),
          readonly(ESPL),
          writable(shuttleAddresses.buffer),
          writable(shuttleAddresses.record),
          writable(shuttleAddresses.metadata),
          readonly(DELEGATION),
          readonly(ASSOCIATED),
          readonly(SYSTEM),
          writable(ownerAta),
          readonly(mint),
          readonly(TOKEN),
        ],
        Buffer.concat([Buffer.from([26]), u32(SHUTTLE_ID), u64(ATOMS), validator.toBuffer()]),
      ),
    ];
    const shape = { kind: "exit", atoms: ATOMS } as const;
    expect(await guardAccepts(world, budgeted(hand), shape)).toBeNull();
    const built = await withdrawSpl(owner, mint, ATOMS, {
      validator,
      payer: owner,
      initAtasIfMissing: true,
      shuttleId: SHUTTLE_ID,
    });
    expect(written(hand)).toEqual(written(built));
  });

  it("seat-deposit: the order book's collateral deposit", async () => {
    const world = makeWorld();
    const owner = world.keypair.publicKey;
    const program = world.pins.programId;
    const authority = pda([Buffer.from("custody"), u64(world.token.custodyNonce)], program);
    const hand = [
      instruction(
        program,
        [
          signer(owner),
          readonly(pda([Buffer.from("exchange")], program)),
          writable(pda([Buffer.from("ledger")], program)),
          readonly(pda([Buffer.from("view"), owner.toBuffer()], program)),
          readonly(authority),
          writable(associated(authority, world.pins.mint)),
          writable(walletAccount(world.env)),
          readonly(TOKEN),
        ],
        // The collateral asset kind is 0.
        Buffer.concat([anchorDiscriminator("deposit"), Buffer.from([0]), u64(ATOMS)]),
      ),
    ];
    const shape = { kind: "seat-deposit", atoms: ATOMS } as const;
    expect(await guardAccepts(world, hand, shape)).toBeNull();
    expect(written(hand)).toEqual(written([depositInstruction(world.env, ATOMS)]));
  });

  it("seat-withdraw: the order book's collateral withdrawal naming every perp market", async () => {
    const world = makeWorld();
    const owner = world.keypair.publicKey;
    const program = world.pins.programId;
    const markets = [0, 1];
    const authority = pda([Buffer.from("custody"), u64(world.token.custodyNonce)], program);
    const risk = markets.flatMap((id) =>
      ["market", "book", "price"].map((seed) =>
        readonly(pda([Buffer.from(seed), Buffer.from([id])], program)),
      ),
    );
    const hand = [
      instruction(
        program,
        [
          signer(owner),
          readonly(pda([Buffer.from("exchange")], program)),
          writable(pda([Buffer.from("ledger")], program)),
          writable(pda([Buffer.from("view"), owner.toBuffer()], program)),
          readonly(authority),
          writable(associated(authority, world.pins.mint)),
          writable(walletAccount(world.env)),
          readonly(TOKEN),
          ...risk,
        ],
        Buffer.concat([anchorDiscriminator("withdraw"), Buffer.from([0]), u64(ATOMS)]),
      ),
    ];
    const shape = { kind: "seat-withdraw", atoms: ATOMS, marketIds: markets } as const;
    expect(await guardAccepts(world, hand, shape)).toBeNull();
    expect(written(hand)).toEqual(written([withdrawInstruction(world.env, ATOMS, markets)]));
  });
});
