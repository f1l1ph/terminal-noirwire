import {
  delegateEataPermissionIx,
  delegateSpl,
  delegateEphemeralAtaIx,
  deriveEphemeralAta,
  initEphemeralAtaIx,
  withdrawSpl,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  MAX_EXIT_PRIORITY_LAMPORTS,
  MAX_MOVE_PRIORITY_LAMPORTS,
  MAX_SETUP_PRIORITY_LAMPORTS,
  computeUnitsFor,
  priorityLamportsFor,
  withComputeBudget,
} from "@/lib/transfer/computeBudget";
import { deposit } from "@/lib/transfer/deposit";
import {
  signableRefusal,
  validatedPins,
  type ShapeContext,
  type TransferShape,
} from "@/lib/transfer/guard";
import {
  createAssociatedTokenAccountIdempotentIx,
  createTransferEnv,
  depositInstruction,
  walletAccount,
  withdrawInstruction,
} from "@/lib/transfer/operation";
import { withdraw } from "@/lib/transfer/withdraw";
import { makeWorld, type World } from "./transferWorld";

const ATOMS = 2_500_000n;
const MARKETS = [0, 1];

const txOf = (payer: PublicKey, instructions: TransactionInstruction[]) =>
  new Transaction({
    feePayer: payer,
    blockhash: PublicKey.default.toBase58(),
    lastValidBlockHeight: 1,
  }).add(...instructions);

const contextOf = (world: World): ShapeContext => ({
  pins: world.pins,
  owner: world.keypair.publicKey,
  token: world.token,
});

const refusalOf = (
  world: World,
  instructions: TransactionInstruction[],
  shape: TransferShape,
  payer = world.keypair.publicKey,
) => signableRefusal(contextOf(world), txOf(payer, instructions), shape);

const moveOf = async (world: World, validator = world.pins.validator, mint = world.pins.mint) =>
  withComputeBudget(
    await delegateSpl(world.keypair.publicKey, mint, ATOMS, {
      validator,
      idempotent: false,
      payer: world.keypair.publicKey,
      initVaultIfMissing: true,
      private: false,
    }),
  );

const exitOf = async (world: World) =>
  withdrawSpl(world.keypair.publicKey, world.pins.mint, ATOMS, {
    validator: world.pins.validator,
    payer: world.keypair.publicKey,
    initAtasIfMissing: true,
  });

const EXIT = { kind: "exit", atoms: ATOMS } as const;

describe("exactly what may be signed", () => {
  it("accepts each transaction the flows build", async () => {
    const world = makeWorld();
    const owner = world.keypair.publicKey;
    const { pins } = world;
    const balance = deriveEphemeralAta(owner, pins.mint)[0];
    for (const idempotent of [false, true]) {
      for (const sealed of [false, true]) {
        const move = await delegateSpl(owner, pins.mint, ATOMS, {
          validator: pins.validator,
          idempotent,
          payer: owner,
          initVaultIfMissing: !idempotent,
          private: sealed,
        });
        if (sealed && !idempotent) {
          move.push(delegateEataPermissionIx(owner, balance, pins.validator));
        }
        expect(
          await refusalOf(world, withComputeBudget(move), { kind: "move", atoms: ATOMS, sealed }),
        ).toBeNull();
      }
    }
    expect(await refusalOf(world, withComputeBudget(await exitOf(world)), EXIT)).toBeNull();
    const setup = withComputeBudget([
      createAssociatedTokenAccountIdempotentIx(owner, walletAccount(world.env), owner, pins.mint),
      initEphemeralAtaIx(balance, owner, pins.mint, owner),
      delegateEphemeralAtaIx(owner, balance, pins.validator),
    ]);
    expect(await refusalOf(world, setup, { kind: "setup" })).toBeNull();
    expect(
      await refusalOf(world, [depositInstruction(world.env, ATOMS)], {
        kind: "seat-deposit",
        atoms: ATOMS,
      }),
    ).toBeNull();
    expect(
      await refusalOf(world, [withdrawInstruction(world.env, ATOMS, MARKETS)], {
        kind: "seat-withdraw",
        atoms: ATOMS,
        marketIds: MARKETS,
      }),
    ).toBeNull();
  });

  it("refuses an attacker's validator in the data even with the pinned one added as an unused account", async () => {
    const world = makeWorld();
    const move = await moveOf(world, Keypair.generate().publicKey);
    const delegation = move[move.length - 1];
    delegation.keys.push({
      pubkey: world.pins.validator,
      isSigner: false,
      isWritable: false,
    });
    expect(await refusalOf(world, move, { kind: "move", atoms: ATOMS, sealed: false })).toMatch(
      /expected move/,
    );
  });

  it("refuses a move of a mint other than the pinned one", async () => {
    const world = makeWorld();
    const move = await moveOf(world, world.pins.validator, Keypair.generate().publicKey);
    expect(await refusalOf(world, move, { kind: "move", atoms: ATOMS, sealed: false })).toMatch(
      /expected move/,
    );
  });

  it("accepts only the one privacy mode the custody has", async () => {
    const world = makeWorld();
    const owner = world.keypair.publicKey;
    const { pins } = world;
    const build = (sealed: boolean) =>
      delegateSpl(owner, pins.mint, ATOMS, {
        validator: pins.validator,
        idempotent: true,
        payer: owner,
        initVaultIfMissing: false,
        private: sealed,
      });
    const open = await build(false);
    const sealed = await build(true);
    expect(await refusalOf(world, open, { kind: "move", atoms: ATOMS, sealed: true })).toMatch(
      /expected move/,
    );
    expect(await refusalOf(world, sealed, { kind: "move", atoms: ATOMS, sealed: false })).toMatch(
      /expected move/,
    );
    expect(
      await refusalOf(world, withComputeBudget(sealed), {
        kind: "move",
        atoms: ATOMS,
        sealed: true,
      }),
    ).toBeNull();
  });

  it("refuses an extra order book instruction", async () => {
    const world = makeWorld();
    const one = depositInstruction(world.env, ATOMS);
    expect(
      await refusalOf(world, [one, depositInstruction(world.env, ATOMS)], {
        kind: "seat-deposit",
        atoms: ATOMS,
      }),
    ).toMatch(/expected seat-deposit/);
  });

  it("refuses an order book instruction with a flipped writable flag", async () => {
    const world = makeWorld();
    const one = depositInstruction(world.env, ATOMS);
    const at = one.keys.findIndex((key) => key.isWritable && !key.isSigner);
    one.keys[at] = { ...one.keys[at], isWritable: false };
    expect(await refusalOf(world, [one], { kind: "seat-deposit", atoms: ATOMS })).toMatch(
      /expected seat-deposit/,
    );
  });

  it("refuses a wrong amount", async () => {
    const world = makeWorld();
    expect(
      await refusalOf(world, [depositInstruction(world.env, ATOMS + 1n)], {
        kind: "seat-deposit",
        atoms: ATOMS,
      }),
    ).toMatch(/expected seat-deposit/);
    const move = await moveOf(world);
    expect(
      await refusalOf(world, move, { kind: "move", atoms: ATOMS + 1n, sealed: false }),
    ).toMatch(/expected move/);
  });

  it("refuses a missing or reordered instruction", async () => {
    const world = makeWorld();
    const out = await exitOf(world);
    expect(await refusalOf(world, withComputeBudget(out.slice(1)), EXIT)).toMatch(/expected exit/);
    expect(await refusalOf(world, withComputeBudget([...out].reverse()), EXIT)).toMatch(
      /expected exit/,
    );
  });

  describe("the compute budget of the transactions sent to Solana", () => {
    const [limit, price] = withComputeBudget([]);
    const budgeted = async (world: World) => withComputeBudget(await exitOf(world));

    it("accepts the exit with its budget and refuses it without", async () => {
      const world = makeWorld();
      expect(await refusalOf(world, await budgeted(world), EXIT)).toBeNull();
      expect(await refusalOf(world, await exitOf(world), EXIT)).toMatch(/expected exit/);
    });

    it("refuses the price before the limit", async () => {
      const world = makeWorld();
      const [, , ...rest] = await budgeted(world);
      expect(await refusalOf(world, [price, limit, ...rest], EXIT)).toMatch(/expected exit/);
    });

    it("refuses a changed unit limit", async () => {
      const world = makeWorld();
      const [, same, ...rest] = await budgeted(world);
      const changed = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
      expect(await refusalOf(world, [changed, same, ...rest], EXIT)).toMatch(/expected exit/);
    });

    it("refuses a changed unit price", async () => {
      const world = makeWorld();
      const [same, , ...rest] = await budgeted(world);
      const changed = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_001 });
      expect(await refusalOf(world, [same, changed, ...rest], EXIT)).toMatch(/expected exit/);
      expect(await refusalOf(world, [same, price, ...rest], EXIT)).toBeNull();
    });

    it("refuses a third budget instruction", async () => {
      const world = makeWorld();
      const instructions = await budgeted(world);
      const extra = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 });
      expect(await refusalOf(world, [...instructions, extra], EXIT)).toMatch(/expected exit/);
      expect(await refusalOf(world, [extra, ...instructions], EXIT)).toMatch(/expected exit/);
    });

    it("gives the setup and the move the same two instructions, and the rollup shapes none", async () => {
      const world = makeWorld();
      const owner = world.keypair.publicKey;
      const balance = deriveEphemeralAta(owner, world.pins.mint)[0];
      const delegate = delegateEphemeralAtaIx(owner, balance, world.pins.validator);
      expect(await refusalOf(world, [delegate], { kind: "setup" })).toMatch(/expected setup/);
      expect(await refusalOf(world, withComputeBudget([delegate]), { kind: "setup" })).toBeNull();
      const move = await moveOf(world);
      expect(
        await refusalOf(world, move.slice(2), { kind: "move", atoms: ATOMS, sealed: false }),
      ).toMatch(/expected move/);
      const seat = depositInstruction(world.env, ATOMS);
      const shape = { kind: "seat-deposit", atoms: ATOMS } as const;
      expect(await refusalOf(world, withComputeBudget([seat]), shape)).toMatch(
        /expected seat-deposit/,
      );
      expect(await refusalOf(world, [seat], shape)).toBeNull();
    });
  });

  it("keeps the largest Solana transaction under the size limit with the budget", async () => {
    const world = makeWorld();
    const owner = world.keypair.publicKey;
    const { pins } = world;
    const balance = deriveEphemeralAta(owner, pins.mint)[0];
    const sealedFirst = await delegateSpl(owner, pins.mint, ATOMS, {
      validator: pins.validator,
      idempotent: false,
      payer: owner,
      initVaultIfMissing: true,
      private: true,
    });
    sealedFirst.push(delegateEataPermissionIx(owner, balance, pins.validator));
    const setup = [
      createAssociatedTokenAccountIdempotentIx(owner, walletAccount(world.env), owner, pins.mint),
      initEphemeralAtaIx(balance, owner, pins.mint, owner),
      delegateEphemeralAtaIx(owner, balance, pins.validator),
    ];
    const exit = await exitOf(world);
    const lists = [sealedFirst, setup, exit];
    const maxFee = (list: TransactionInstruction[]) =>
      priorityLamportsFor(computeUnitsFor(list.length));
    expect(maxFee(sealedFirst)).toBe(MAX_MOVE_PRIORITY_LAMPORTS);
    expect(maxFee(setup)).toBe(MAX_SETUP_PRIORITY_LAMPORTS);
    expect(maxFee(exit)).toBe(MAX_EXIT_PRIORITY_LAMPORTS);
    for (const list of lists) {
      const transaction = txOf(owner, withComputeBudget(list));
      transaction.recentBlockhash = Keypair.generate().publicKey.toBase58();
      transaction.sign(world.keypair);
      expect(transaction.serialize().length).toBeLessThan(1232);
    }
  });

  it("refuses a foreign program and a system transfer", async () => {
    const world = makeWorld();
    const owner = world.keypair.publicKey;
    const foreign = new TransactionInstruction({
      programId: PublicKey.unique(),
      keys: [{ pubkey: owner, isSigner: true, isWritable: true }],
      data: Buffer.alloc(1),
    });
    const drain = SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: PublicKey.unique(),
      lamports: 1,
    });
    const shape = { kind: "seat-deposit", atoms: ATOMS } as const;
    expect(await refusalOf(world, [foreign], shape)).toMatch(/expected/);
    expect(await refusalOf(world, [drain], shape)).toMatch(/expected/);
  });

  it("refuses a transaction the owner does not pay for", async () => {
    const world = makeWorld();
    const one = depositInstruction(world.env, ATOMS);
    expect(
      await refusalOf(
        world,
        [one],
        { kind: "seat-deposit", atoms: ATOMS },
        Keypair.generate().publicKey,
      ),
    ).toMatch(/fee payer/);
  });
});

describe("the env", () => {
  it("rejects pins that are empty or repeated, or a token that is not the pinned mint", () => {
    const { pins, env, token } = makeWorld();
    expect(() => validatedPins({ ...pins, mint: PublicKey.default })).toThrow(/none of them empty/);
    expect(() => validatedPins({ ...pins, validator: pins.mint })).toThrow(/different/);
    expect(() =>
      createTransferEnv({
        ...env,
        pins,
        exchange: { ...env.exchange, token: { ...token, mint: PublicKey.unique() } },
        signChecked: async (transaction) => transaction,
      }),
    ).toThrow(/pinned mint/);
  });

  it("will not pass a transaction that is not the expected one to the signer", async () => {
    const world = makeWorld();
    const foreign = new TransactionInstruction({
      programId: PublicKey.unique(),
      keys: [{ pubkey: world.keypair.publicKey, isSigner: true, isWritable: true }],
      data: Buffer.alloc(1),
    });
    await expect(
      world.env.signChecked(txOf(world.keypair.publicKey, [foreign]), {
        kind: "seat-deposit",
        atoms: ATOMS,
      }),
    ).rejects.toThrow(/Refusing to sign/);
    expect(world.events).toEqual([]);
  });

  it("deposits through a sealed custody and into an existing balance", async () => {
    const sealed = makeWorld();
    sealed.env.sealed = true;
    sealed.solana.script({ fate: "land", effect: sealed.moveEffect(ATOMS) });
    sealed.rollup.script({ fate: "land", effect: sealed.depositEffect(ATOMS) });
    expect(await deposit(sealed.env, { amount: "2.5" })).toMatchObject({ status: "done" });

    const existing = makeWorld();
    existing.delegate(USDC_TEN);
    existing.solana.script({ fate: "land", effect: existing.moveEffect(ATOMS) });
    existing.rollup.script({ fate: "land", effect: existing.depositEffect(ATOMS) });
    expect(await deposit(existing.env, { amount: "2.5" })).toMatchObject({ status: "done" });
  });

  it("withdraws through the same checks", async () => {
    const world = makeWorld();
    world.delegate(0n);
    world.rollup.script({ fate: "land", effect: world.seatEffect(ATOMS) });
    world.solana.script({ fate: "land", effect: world.shuttleEffect(ATOMS) });
    const outcome = await withdraw(world.env, { amount: "2.5", freeCollateral: 5_000_000n });
    expect(outcome).toMatchObject({ status: "done" });
  });
});

const USDC_TEN = 10_000_000n;
