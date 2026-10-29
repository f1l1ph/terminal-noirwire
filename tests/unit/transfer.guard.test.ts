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
  MAX_MICRO_LAMPORTS_PER_UNIT,
  MAX_SETUP_PRIORITY_LAMPORTS,
  MICRO_LAMPORTS_PER_UNIT,
  MIN_COMPUTE_UNITS,
  computeUnitsFor,
  priorityLamportsFor,
  withComputeBudget,
} from "@/lib/transfer/computeBudget";
import { deposit } from "@/lib/transfer/deposit";
import {
  fundKeyInstructions,
  moveKeyInstructions,
  returnKeyInstructions,
} from "@/lib/transfer/depositKey";
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
  keyDepositInstruction,
  walletAccount,
  withdrawInstruction,
} from "@/lib/transfer/operation";
import { associatedTokenAddress } from "@/lib/transfer/tokenAccounts";
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

    it("accepts a unit limit from the floor to the allowance, and refuses one outside it", async () => {
      const world = makeWorld();
      const [, same, ...rest] = await budgeted(world);
      const limit = (units: number) => ComputeBudgetProgram.setComputeUnitLimit({ units });
      const allowance = computeUnitsFor(rest.length);
      for (const units of [MIN_COMPUTE_UNITS, 123_457, allowance]) {
        expect(
          await refusalOf(world, [limit(units), same, ...rest], EXIT),
          String(units),
        ).toBeNull();
      }
      for (const units of [MIN_COMPUTE_UNITS - 1, allowance + 1, 0]) {
        expect(await refusalOf(world, [limit(units), same, ...rest], EXIT), String(units)).toMatch(
          /expected exit/,
        );
      }
    });

    it("accepts a unit price from the fixed price to the cap, and refuses one outside it", async () => {
      const world = makeWorld();
      const [same, , ...rest] = await budgeted(world);
      const priced = (microLamports: number) =>
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports });
      for (const microLamports of [
        MICRO_LAMPORTS_PER_UNIT,
        MICRO_LAMPORTS_PER_UNIT + 1,
        MAX_MICRO_LAMPORTS_PER_UNIT,
      ]) {
        expect(
          await refusalOf(world, [same, priced(microLamports), ...rest], EXIT),
          String(microLamports),
        ).toBeNull();
      }
      for (const microLamports of [
        0,
        MICRO_LAMPORTS_PER_UNIT - 1,
        MAX_MICRO_LAMPORTS_PER_UNIT + 1,
      ]) {
        expect(
          await refusalOf(world, [same, priced(microLamports), ...rest], EXIT),
          String(microLamports),
        ).toMatch(/expected exit/);
      }
      expect(await refusalOf(world, [same, price, ...rest], EXIT)).toBeNull();
    });

    it("still compares every instruction after the budget exactly", async () => {
      const world = makeWorld();
      const [limit2, price2, first, ...rest] = await budgeted(world);
      expect(await refusalOf(world, [limit2, price2, ...rest], EXIT)).toMatch(/expected exit/);
      expect(await refusalOf(world, [limit2, price2, first, ...rest], EXIT)).toBeNull();
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
    sealed.stagedLanding(ATOMS);
    sealed.rollup.script({ fate: "land", effect: sealed.depositEffect(ATOMS) });
    expect(await deposit(sealed.env, { amount: "2.5" })).toMatchObject({ status: "done" });

    const existing = makeWorld();
    existing.delegateKey(USDC_TEN);
    existing.stagedLanding(ATOMS);
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

describe("the deposit key's transactions", () => {
  const keyFund = (world: World, atoms = ATOMS, lamports = 4_000_000) =>
    withComputeBudget(
      fundKeyInstructions({
        owner: world.keypair.publicKey,
        key: world.depositKey.publicKey,
        mint: world.pins.mint,
        decimals: 6,
        atoms,
        lamports,
      }),
    );
  const keyFundShape = (world: World, atoms = ATOMS, lamports = 4_000_000) =>
    ({
      kind: "key-fund",
      atoms,
      key: world.depositKey.publicKey,
      decimals: 6,
      lamports,
    }) as const;

  it("accepts the wallet's payment to the key and nothing altered", async () => {
    const world = makeWorld();
    expect(await refusalOf(world, keyFund(world), keyFundShape(world))).toBeNull();
    expect(
      await refusalOf(world, keyFund(world, ATOMS, 0), keyFundShape(world, ATOMS, 0)),
    ).toBeNull();
    const instructions = keyFund(world);
    expect(instructions.map((each) => each.programId.toBase58())).toContain(
      SystemProgram.programId.toBase58(),
    );
    expect(keyFund(world, ATOMS, 0).map((each) => each.programId.toBase58())).not.toContain(
      SystemProgram.programId.toBase58(),
    );
  });

  it("refuses a payment to the key that differs in its amount, its SOL, its fee payer or its key", async () => {
    const world = makeWorld();
    const expected = /not the expected key-fund/;
    expect(await refusalOf(world, keyFund(world, ATOMS + 1n), keyFundShape(world))).toMatch(
      expected,
    );
    expect(await refusalOf(world, keyFund(world, ATOMS, 4_000_001), keyFundShape(world))).toMatch(
      expected,
    );
    expect(await refusalOf(world, keyFund(world, ATOMS, 0), keyFundShape(world))).toMatch(expected);
    expect(await refusalOf(world, keyFund(makeWorld()), keyFundShape(world))).toMatch(expected);
    expect(
      await refusalOf(world, keyFund(world), keyFundShape(world), world.depositKey.publicKey),
    ).toMatch(/owner is not the fee payer/);
    const drained = keyFund(world);
    drained.push(
      SystemProgram.transfer({
        fromPubkey: world.keypair.publicKey,
        toPubkey: PublicKey.unique(),
        lamports: 1,
      }),
    );
    expect(await refusalOf(world, drained, keyFundShape(world))).toMatch(expected);
  });

  it("has the owner as the only signer of the payment to the key", () => {
    const world = makeWorld();
    const message = txOf(world.keypair.publicKey, keyFund(world)).compileMessage();
    expect(message.header.numRequiredSignatures).toBe(1);
    expect(message.accountKeys[0].equals(world.keypair.publicKey)).toBe(true);
  });

  const keyMove = async (world: World, atoms = ATOMS, first = true, sealed = false) =>
    withComputeBudget(
      await moveKeyInstructions({
        key: world.depositKey.publicKey,
        mint: world.pins.mint,
        validator: world.pins.validator,
        atoms,
        sealed,
        first,
        vaultMissing: first,
      }),
    );
  const keyMoveShape = (world: World, atoms = ATOMS, sealed = false) =>
    ({ kind: "key-move", atoms, sealed, key: world.depositKey.publicKey }) as const;

  it("accepts the key's own move into the rollup only when the key pays and signs alone", async () => {
    const world = makeWorld();
    const key = world.depositKey.publicKey;
    for (const sealed of [false, true]) {
      for (const first of [true, false]) {
        expect(
          await refusalOf(
            world,
            await keyMove(world, ATOMS, first, sealed),
            keyMoveShape(world, ATOMS, sealed),
            key,
          ),
        ).toBeNull();
      }
    }
    const instructions = await keyMove(world, ATOMS, true, true);
    expect(await refusalOf(world, instructions, keyMoveShape(world, ATOMS, true))).toMatch(
      /deposit key is not the fee payer/,
    );
    expect(txOf(key, instructions).compileMessage().header.numRequiredSignatures).toBe(1);
  });

  it("refuses a key move that differs in its amount, its key or its custody", async () => {
    const world = makeWorld();
    const key = world.depositKey.publicKey;
    const expected = /not the expected key-move/;
    expect(
      await refusalOf(world, await keyMove(world, ATOMS + 1n), keyMoveShape(world), key),
    ).toMatch(expected);
    expect(await refusalOf(world, await keyMove(makeWorld()), keyMoveShape(world), key)).toMatch(
      expected,
    );
    expect(
      await refusalOf(world, await keyMove(world, ATOMS, true, true), keyMoveShape(world), key),
    ).toMatch(expected);
  });

  it("accepts the key's payment back to the owner only when the key pays, and nothing else", async () => {
    const world = makeWorld();
    const key = world.depositKey.publicKey;
    const instructions = withComputeBudget(
      returnKeyInstructions({
        owner: world.keypair.publicKey,
        key,
        mint: world.pins.mint,
        decimals: 6,
        atoms: ATOMS,
      }),
    );
    const shape = { kind: "key-return", atoms: ATOMS, key, decimals: 6 } as const;
    expect(await refusalOf(world, instructions, shape, key)).toBeNull();
    expect(await refusalOf(world, instructions, shape)).toMatch(/deposit key is not the fee payer/);
    expect(await refusalOf(world, instructions, { ...shape, atoms: ATOMS + 1n }, key)).toMatch(
      /not the expected key-return/,
    );
    const elsewhere = withComputeBudget(
      returnKeyInstructions({
        owner: PublicKey.unique(),
        key,
        mint: world.pins.mint,
        decimals: 6,
        atoms: ATOMS,
      }),
    );
    expect(await refusalOf(world, elsewhere, shape, key)).toMatch(/not the expected key-return/);
  });

  it("allows the making of the owner's token account in the key's return and in no other key shape", async () => {
    const world = makeWorld();
    const key = world.depositKey.publicKey;
    const parts = {
      owner: world.keypair.publicKey,
      key,
      mint: world.pins.mint,
      decimals: 6,
      atoms: ATOMS,
    };
    const [create, pay] = returnKeyInstructions(parts);
    const shape = { kind: "key-return", atoms: ATOMS, key, decimals: 6 } as const;
    expect(await refusalOf(world, withComputeBudget([create, pay]), shape, key)).toBeNull();
    expect(await refusalOf(world, withComputeBudget([pay]), shape, key)).toMatch(
      /not the expected key-return/,
    );
    const payerIsOwner = createAssociatedTokenAccountIdempotentIx(
      world.keypair.publicKey,
      associatedTokenAddress(world.keypair.publicKey, world.pins.mint),
      world.keypair.publicKey,
      world.pins.mint,
    );
    expect(await refusalOf(world, withComputeBudget([payerIsOwner, pay]), shape, key)).toMatch(
      /not the expected key-return/,
    );
    const move = await keyMove(world);
    const withCreate = [...move.slice(0, 2), create, ...move.slice(2)];
    expect(await refusalOf(world, move, keyMoveShape(world), key)).toBeNull();
    expect(await refusalOf(world, withCreate, keyMoveShape(world), key)).toMatch(
      /not the expected key-move/,
    );
  });

  it("accepts the key's own collateral deposit only when the key pays", async () => {
    const world = makeWorld();
    const key = world.depositKey.publicKey;
    const instructions = [keyDepositInstruction(world.env, ATOMS)];
    const shape = { kind: "key-deposit", atoms: ATOMS, key } as const;
    expect(await refusalOf(world, instructions, shape, key)).toBeNull();
    expect(await refusalOf(world, instructions, shape)).toMatch(/deposit key is not the fee payer/);
    expect(await refusalOf(world, instructions, { ...shape, atoms: ATOMS + 1n }, key)).toMatch(
      /not the expected key-deposit/,
    );
  });
});
