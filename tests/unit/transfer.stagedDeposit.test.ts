import { deriveVault } from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  ComputeBudgetProgram,
  SystemInstruction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { actionsOf, attentionOf } from "@/lib/transfer/attention";
import { PublicKey } from "@solana/web3.js";
import { signableRefusal } from "@/lib/transfer/guard";
import { sweepKeySol } from "@/lib/transfer/keySweep";
import {
  MAX_KEY_TRANSFER_FEE_LAMPORTS,
  SWEEP_MIN_LAMPORTS,
  withComputeBudget,
  BASE_FEE_LAMPORTS,
  MAX_FUND_PRIORITY_LAMPORTS,
  MAX_MOVE_PRIORITY_LAMPORTS,
  ROUND_TRIP_LAMPORTS,
} from "@/lib/transfer/computeBudget";
import { deposit } from "@/lib/transfer/deposit";
import { depositKeyAccount } from "@/lib/transfer/depositKey";
import { isStaged } from "@/lib/transfer/journal";
import {
  TOKEN_ACCOUNT_BYTES,
  keyMoveAccountBytes,
  keyMoveLamports,
  keyShortfallLamports,
} from "@/lib/transfer/keyMoveCost";
import { outcomeLine } from "@/lib/transfer/outcomeCopy";
import { returnToWallet } from "@/lib/transfer/returnToWallet";
import { associatedTokenAddress } from "@/lib/transfer/tokenAccounts";
import { finishCompleted } from "@/lib/transfer/withdraw";
import { USDC, makeWorld, type World } from "./transferWorld";

const ATOMS = 2_500_000n;
const AMOUNT = "2.5";
const RENT_PER_BYTE = 3_480 * 2;
const rentOf = (accounts: number[]) =>
  accounts.reduce((sum, bytes) => sum + (128 + bytes) * RENT_PER_BYTE, 0);
const FEES = BASE_FEE_LAMPORTS + MAX_MOVE_PRIORITY_LAMPORTS;

const resumeOf = (world: World, id = "id1", atoms = ATOMS) =>
  deposit(world.env, {
    amount: AMOUNT,
    intent: { kind: "resume", id, atoms: atoms.toString() },
  });

/** The world's escrow exists, as it does once anyone has deposited. */
const withEscrow = (world: World) => world.solana.setToken(deriveVault(world.pins.mint)[0], 0n);

const finalized = { err: null, confirmationStatus: "finalized" } as const;

/** The SOL the wallet's payment to the key carries, 0 when it carries none. */
function sentLamports(raw: Uint8Array): number {
  const transfers = Transaction.from(raw).instructions.filter((each) =>
    each.programId.equals(SystemProgram.programId),
  );
  return transfers.reduce(
    (sum, each) => sum + Number(SystemInstruction.decodeTransfer(each).lamports),
    0,
  );
}

/**
 * A deposit whose payment to the deposit key landed and whose move did not:
 * the node takes the move and never includes it (`swallow`), runs it and fails
 * it (`fail`), or the network refuses to simulate it so it is never sent
 * (`unsent`).
 */
async function fundedDeposit(world: World, move: "swallow" | "fail" | "unsent") {
  world.solana.script({ fate: "land", effect: world.fundEffect(ATOMS) });
  if (move === "unsent") world.solana.simulateAnswers.push(null, { InstructionError: [0, 1] });
  else if (move === "swallow") world.solana.swallowAll();
  else world.solana.script({ fate: "fail" });
  const outcome = await deposit(world.env, { amount: AMOUNT });
  world.solana.clearPlans();
  world.events.length = 0;
  return outcome;
}

/** A deposit whose payment to the key is taken by the node and never included. */
async function unlandedPayment(world: World) {
  world.solana.swallowAll();
  const outcome = await deposit(world.env, { amount: AMOUNT });
  world.solana.clearPlans();
  world.events.length = 0;
  return outcome;
}

describe("the SOL the wallet sends the deposit key", () => {
  const sentFor = async (world: World) => {
    world.stagedLanding(ATOMS);
    world.rollup.script({ fate: "land", effect: world.depositEffect(ATOMS) });
    await deposit(world.env, { amount: AMOUNT });
    return sentLamports(world.solana.rawSent[0]);
  };

  it("is the rent of the first move's accounts and its fees for a first deposit, escrow missing", async () => {
    const world = makeWorld();
    expect(await sentFor(world)).toBe(rentOf([32, 72, 165, 72, 72, 96, 125]) + FEES);
  });

  it("leaves out the escrow's rent when it exists", async () => {
    const world = makeWorld();
    withEscrow(world);
    expect(await sentFor(world)).toBe(rentOf([72, 72, 96, 125]) + FEES);
  });

  it("is the rent of the shuttle a later move makes, and its fees, for a later deposit", async () => {
    const world = makeWorld();
    withEscrow(world);
    world.delegateKey(USDC);
    expect(await sentFor(world)).toBe(rentOf([72, 72, 165, 72, 96, 125]) + FEES);
  });

  it("adds the permission and its delegation for a sealed first deposit", async () => {
    const world = makeWorld();
    world.env.sealed = true;
    withEscrow(world);
    expect(await sentFor(world)).toBe(rentOf([72, 72, 96, 125, 72, 72, 96, 104]) + FEES);
  });

  it("is what the move needs less what the key holds", async () => {
    const world = makeWorld();
    withEscrow(world);
    const needed = rentOf([72, 72, 96, 125]) + FEES;
    world.solana.lamportsOf.set(world.depositKey.publicKey.toBase58(), 1_000_000);
    expect(await sentFor(world)).toBe(needed - 1_000_000);
  });

  it("is nothing, and no transfer instruction, when the key already holds enough", async () => {
    const world = makeWorld();
    withEscrow(world);
    const needed = rentOf([72, 72, 96, 125]) + FEES;
    world.solana.lamportsOf.set(world.depositKey.publicKey.toBase58(), needed);
    expect(await sentFor(world)).toBe(0);
    const programs = Transaction.from(world.solana.rawSent[0]).instructions.map((each) =>
      each.programId.toBase58(),
    );
    expect(programs).not.toContain(SystemProgram.programId.toBase58());
    expect(programs).toContain(ComputeBudgetProgram.programId.toBase58());
  });

  it("is never more than the wallet is required to hold before it starts", async () => {
    const world = makeWorld();
    const worst = await keyMoveLamports(world.solana, {
      first: true,
      vaultMissing: true,
      sealed: true,
    });
    const keyAccountRent =
      await world.solana.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_BYTES);
    expect(
      worst + keyAccountRent + BASE_FEE_LAMPORTS + MAX_FUND_PRIORITY_LAMPORTS,
    ).toBeLessThanOrEqual(ROUND_TRIP_LAMPORTS);
  });

  it("counts every account the move makes, from the SDK's own sizes where it has them", async () => {
    expect(keyMoveAccountBytes({ first: true, vaultMissing: true, sealed: false })).toEqual([
      32, 72, 165, 72, 72, 96, 125,
    ]);
    const world = makeWorld();
    const parts = { first: false, vaultMissing: false, sealed: false };
    expect(await keyMoveLamports(world.solana, parts)).toBe(
      rentOf(keyMoveAccountBytes(parts)) + FEES,
    );
    expect(await keyShortfallLamports(world.solana, world.depositKey.publicKey, parts)).toBe(
      rentOf(keyMoveAccountBytes(parts)) + FEES,
    );
  });
});

describe("the wallet's payment to the deposit key", () => {
  it("has the owner as its one required signer and only the funding instructions", async () => {
    const world = makeWorld();
    world.stagedLanding(ATOMS);
    world.rollup.script({ fate: "land", effect: world.depositEffect(ATOMS) });
    await deposit(world.env, { amount: AMOUNT });
    const fund = Transaction.from(world.solana.rawSent[0]);
    expect(fund.compileMessage().header.numRequiredSignatures).toBe(1);
    expect(fund.feePayer?.equals(world.keypair.publicKey)).toBe(true);
    expect(fund.instructions.map((each) => each.programId.toBase58())).toEqual([
      ComputeBudgetProgram.programId.toBase58(),
      ComputeBudgetProgram.programId.toBase58(),
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      SystemProgram.programId.toBase58(),
    ]);
    const system = SystemInstruction.decodeTransfer(fund.instructions[4]);
    expect(system.fromPubkey.equals(world.keypair.publicKey)).toBe(true);
    expect(system.toPubkey.equals(world.depositKey.publicKey)).toBe(true);
    const tokens = fund.instructions[3];
    expect(
      tokens.keys[2].pubkey.equals(depositKeyAccount(world.depositKey.publicKey, world.pins.mint)),
    ).toBe(true);
    expect(tokens.data.readBigUInt64LE(1)).toBe(ATOMS);
  });

  it("sends nothing when the network would refuse it", async () => {
    const world = makeWorld();
    world.solana.simulateAnswers.push({ InstructionError: [0, 1] });
    expect(await deposit(world.env, { amount: AMOUNT })).toMatchObject({
      status: "refused",
      reason: "simulation-failed",
    });
    expect(world.solana.rawSent).toEqual([]);
    expect(world.rows.size).toBe(0);
    expect(world.signed).toHaveLength(0);
  });
});

describe("the deposit key's move", () => {
  it("is paid and signed by the key alone, and the owner is not in it", async () => {
    const world = makeWorld();
    world.stagedLanding(ATOMS);
    world.rollup.script({ fate: "land", effect: world.depositEffect(ATOMS) });
    await deposit(world.env, { amount: AMOUNT });
    const move = Transaction.from(world.solana.rawSent[1]);
    expect(move.feePayer?.equals(world.depositKey.publicKey)).toBe(true);
    expect(move.compileMessage().header.numRequiredSignatures).toBe(1);
    expect(move.verifySignatures()).toBe(true);
    expect(
      move.compileMessage().accountKeys.some((each) => each.equals(world.keypair.publicKey)),
    ).toBe(false);
    expect(
      move.compileMessage().accountKeys.some((each) => each.equals(world.depositKey.publicKey)),
    ).toBe(true);
  });

  it("is journaled as a move send before it is broadcast, after the funding", async () => {
    const world = makeWorld();
    await fundedDeposit(world, "swallow");
    expect(world.record()?.sends.map((send) => send.leg)).toEqual(["fund", "move"]);
    expect(world.record()?.sends[1]).toMatchObject({ moved: ATOMS.toString() });
  });

  it("waits for the key's token account to show the tokens and sends nothing until it does", async () => {
    const world = makeWorld();
    world.solana.script({ fate: "land" });
    const outcome = await deposit(world.env, { amount: AMOUNT });
    expect(outcome).toMatchObject({ status: "waiting" });
    expect((outcome as { message: string }).message).toMatch(/does not yet show/);
    expect(new Set(world.solana.sent).size).toBe(1);
    expect(world.record()?.sends.map((send) => send.leg)).toEqual(["fund"]);
  });
});

describe("resuming a deposit through the deposit key", () => {
  it("has nothing to resume when nothing was sent, and sends nothing", async () => {
    const world = makeWorld();
    expect(await resumeOf(world)).toMatchObject({ status: "refused", reason: "record-changed" });
    expect(world.events).toEqual([]);
  });

  it("waits while the payment may still land, and sends neither the payment nor the move again", async () => {
    const world = makeWorld();
    expect(await unlandedPayment(world)).toMatchObject({ status: "waiting" });
    expect(await resumeOf(world)).toMatchObject({ status: "waiting" });
    expect(new Set(world.solana.sent).size).toBe(1);
    expect(world.events).toEqual([]);
  });

  it("drops the record and sends nothing once the payment can never land", async () => {
    const world = makeWorld();
    await unlandedPayment(world);
    world.solana.height += 400;
    const outcome = await resumeOf(world);
    expect(outcome).toMatchObject({ status: "refused", reason: "send-failed" });
    expect(world.rows.size).toBe(0);
    expect(new Set(world.solana.sent).size).toBe(1);
    expect(world.signed).toHaveLength(1);
  });

  it("sends the move, built fresh and signed by the key, when the payment landed and no move was sent, and never the payment again", async () => {
    const world = makeWorld();
    const first = await fundedDeposit(world, "unsent");
    expect(first).toMatchObject({ status: "refused", reason: "simulation-failed" });
    expect(world.record()?.sends.map((send) => send.leg)).toEqual(["fund"]);
    const fundSignature = world.record()!.sends[0].signature;
    world.solana.script({ fate: "land", effect: world.moveEffect(ATOMS) });
    world.rollup.script({ fate: "land", effect: world.depositEffect(ATOMS) });
    expect(await resumeOf(world)).toMatchObject({ status: "done", id: "id1" });
    expect(world.events).not.toContain("sign");
    expect(world.signed).toHaveLength(1);
    expect(world.solana.sent.filter((signature) => signature === fundSignature)).toHaveLength(1);
    expect(world.solana.sent).toHaveLength(2);
    const move = Transaction.from(world.solana.rawSent[1]);
    expect(move.feePayer?.equals(world.depositKey.publicKey)).toBe(true);
    expect(move.compileMessage().header.numRequiredSignatures).toBe(1);
    expect(world.rows.size).toBe(0);
  });

  it("sends nothing while the move may still land", async () => {
    const world = makeWorld();
    expect(await fundedDeposit(world, "swallow")).toMatchObject({ status: "waiting" });
    expect(await resumeOf(world)).toMatchObject({ status: "waiting" });
    expect(await resumeOf(world)).toMatchObject({ status: "waiting" });
    expect(new Set(world.solana.sent).size).toBe(2);
    expect(world.signed).toHaveLength(1);
    expect(world.events).toEqual([]);
  });

  it("goes on to the deposit into the seat once the uncertain move shows as landed, without sending the move again", async () => {
    const world = makeWorld();
    await fundedDeposit(world, "swallow");
    const [, move] = world.record()!.sends;
    world.solana.statuses.set(move.signature, finalized);
    world.moveEffect(ATOMS)();
    world.rollup.script({ fate: "land", effect: world.depositEffect(ATOMS) });
    expect(await resumeOf(world)).toMatchObject({ status: "done" });
    expect(new Set(world.solana.sent).size).toBe(2);
  });

  it("sends a fresh move after the earlier one failed for good, and the wallet is not asked", async () => {
    const world = makeWorld();
    const first = await fundedDeposit(world, "fail");
    expect(first).toMatchObject({ status: "refused", reason: "send-failed" });
    expect(world.rows.size).toBe(1);
    expect(outcomeLine("deposit", first, 6, 1).text).toBeTruthy();
    world.solana.script({ fate: "land", effect: world.moveEffect(ATOMS) });
    world.rollup.script({ fate: "land", effect: world.depositEffect(ATOMS) });
    expect(await resumeOf(world)).toMatchObject({ status: "done" });
    expect(world.record()).toBeUndefined();
    expect(new Set(world.solana.sent).size).toBe(3);
    expect(world.signed).toHaveLength(1);
  });

  it("does not send the move again once it landed, and finishes from the rollup", async () => {
    const world = makeWorld();
    world.stagedLanding(ATOMS);
    world.rollup.script({ fate: "swallow" });
    await deposit(world.env, { amount: AMOUNT });
    world.rollup.statuses.set(world.rollup.sent[0], finalized);
    world.events.length = 0;
    expect(await resumeOf(world)).toMatchObject({ status: "done" });
    expect(world.events).toEqual([]);
    expect(new Set(world.solana.sent).size).toBe(2);
  });

  it("still resumes a record of the single-transaction version through its old branch", async () => {
    const world = makeWorld();
    await world.env.journal.record(world.owner, {
      id: "old",
      kind: "deposit",
      atoms: ATOMS.toString(),
      step: "deposit",
      rollupBefore: "0",
      depositKey: world.depositKey.publicKey.toBase58(),
      sends: [
        {
          signature: "sigA",
          lastValidBlockHeight: world.solana.height + 150,
          before: (100n * USDC).toString(),
          moved: ATOMS.toString(),
        },
      ],
    });
    expect(isStaged(world.record()!)).toBe(false);
    expect(await resumeOf(world, "old")).toMatchObject({ status: "waiting" });
    world.solana.statuses.set("sigA", finalized);
    world.delegateKey(ATOMS);
    world.rollup.script({ fate: "land", effect: world.depositEffect(ATOMS) });
    expect(await resumeOf(world, "old")).toMatchObject({ status: "done", id: "old" });
    expect(world.solana.sent).toEqual([]);
    expect(world.signed).toHaveLength(0);
  });

  it("drops a record of the single-transaction version whose send can never land, as before", async () => {
    const world = makeWorld();
    await world.env.journal.record(world.owner, {
      id: "old",
      kind: "deposit",
      atoms: ATOMS.toString(),
      step: "deposit",
      rollupBefore: "0",
      depositKey: world.depositKey.publicKey.toBase58(),
      sends: [
        {
          signature: "sigA",
          lastValidBlockHeight: world.solana.height + 150,
          before: (100n * USDC).toString(),
          moved: ATOMS.toString(),
        },
      ],
    });
    world.solana.height += 400;
    expect(await resumeOf(world, "old")).toMatchObject({
      status: "refused",
      reason: "send-failed",
    });
    expect(world.rows.size).toBe(0);
    expect(world.solana.sent).toEqual([]);
  });
});

describe("sweeping the deposit key's spare SOL back to the owner", () => {
  const RENT_FREE = 128 * RENT_PER_BYTE;
  const KEPT = RENT_FREE + 2 * MAX_KEY_TRANSFER_FEE_LAMPORTS;
  const keyOf = (world: World) => world.depositKey.publicKey.toBase58();

  /** A deposit that lands in full and leaves the key holding `held` lamports once the seat has the USDC. */
  async function depositLeaving(world: World, held: number) {
    world.stagedLanding(ATOMS);
    world.rollup.script({
      fate: "land",
      effect: () => {
        world.depositEffect(ATOMS)();
        world.solana.lamportsOf.set(keyOf(world), held);
      },
    });
    return deposit(world.env, { amount: AMOUNT });
  }

  const lastSend = (world: World) =>
    Transaction.from(world.solana.rawSent[world.solana.rawSent.length - 1]);

  /** The next send lands and takes what it paid out of the key's SOL, as the chain does. */
  const sweepLanding = (world: World) =>
    world.solana.script({
      fate: "land",
      effect: () => {
        const sweep = Transaction.from(world.solana.rawSent[world.solana.rawSent.length - 1]);
        const paid = Number(SystemInstruction.decodeTransfer(sweep.instructions[2]).lamports);
        const held = world.solana.lamportsOf.get(keyOf(world)) ?? 0;
        world.solana.lamportsOf.set(keyOf(world), held - paid - MAX_KEY_TRANSFER_FEE_LAMPORTS);
      },
    });

  it("returns the excess less what the key keeps, with one payment the key alone signs, journaled first", async () => {
    const world = makeWorld();
    expect(await depositLeaving(world, 20_000_000)).toMatchObject({ status: "done" });
    expect(new Set(world.solana.sent).size).toBe(2);
    await sweepKeySol(world.env);
    expect(new Set(world.solana.sent).size).toBe(3);
    const sweep = lastSend(world);
    const key = world.depositKey.publicKey;
    expect(sweep.feePayer?.equals(key)).toBe(true);
    expect(sweep.compileMessage().header.numRequiredSignatures).toBe(1);
    expect(sweep.verifySignatures()).toBe(true);
    expect(sweep.instructions).toHaveLength(3);
    const transfer = SystemInstruction.decodeTransfer(sweep.instructions[2]);
    expect(transfer.fromPubkey.equals(key)).toBe(true);
    expect(transfer.toPubkey.equals(world.keypair.publicKey)).toBe(true);
    expect(Number(transfer.lamports)).toBe(20_000_000 - KEPT);
    expect(world.events.slice(-2)).toEqual(["journal:record", "broadcast:solana"]);
    expect(world.signed).toHaveLength(1);
  });

  it("leaves the key enough for the payment itself and a later return to the wallet", () => {
    const left = 20_000_000 - (20_000_000 - KEPT) - MAX_KEY_TRANSFER_FEE_LAMPORTS;
    expect(left).toBe(RENT_FREE + MAX_KEY_TRANSFER_FEE_LAMPORTS);
  });

  it("is its own record, closed once the sweep is final, and sweeps nothing more", async () => {
    const world = makeWorld();
    await depositLeaving(world, 20_000_000);
    sweepLanding(world);
    await sweepKeySol(world.env);
    expect(world.rows.size).toBe(1);
    expect(world.record()?.sends.map((send) => send.leg)).toEqual(["sweep"]);
    const [attention] = [world.record()!].map((record) => attentionOf(record, null, [record]));
    expect(attention).toMatchObject({ operation: "sweep", resumable: false, returnable: false });
    await sweepKeySol(world.env);
    expect(world.rows.size).toBe(0);
    expect(new Set(world.solana.sent).size).toBe(3);
  });

  it("sweeps after a first move that failed for good and a retried one that landed", async () => {
    const world = makeWorld();
    expect(await fundedDeposit(world, "fail")).toMatchObject({ reason: "send-failed" });
    world.solana.script({ fate: "land", effect: world.moveEffect(ATOMS) });
    world.rollup.script({
      fate: "land",
      effect: () => {
        world.depositEffect(ATOMS)();
        world.solana.lamportsOf.set(keyOf(world), 20_000_000);
      },
    });
    expect(await resumeOf(world)).toMatchObject({ status: "done" });
    expect(world.rows.size).toBe(0);
    await sweepKeySol(world.env);
    expect(new Set(world.solana.sent).size).toBe(4);
    expect(Number(SystemInstruction.decodeTransfer(lastSend(world).instructions[2]).lamports)).toBe(
      20_000_000 - KEPT,
    );
  });

  it("sweeps on a later look after a transient error left it undone", async () => {
    const world = makeWorld();
    await depositLeaving(world, 20_000_000);
    const read = world.solana.getBalance.bind(world.solana);
    world.solana.getBalance = async () => {
      throw new Error("endpoint down");
    };
    await sweepKeySol(world.env);
    expect(new Set(world.solana.sent).size).toBe(2);
    expect(world.rows.size).toBe(0);
    world.solana.getBalance = read;
    await sweepKeySol(world.env);
    expect(new Set(world.solana.sent).size).toBe(3);
  });

  it("sweeps nothing while any transfer is open", async () => {
    const world = makeWorld();
    await fundedDeposit(world, "unsent");
    world.solana.lamportsOf.set(keyOf(world), 20_000_000);
    await sweepKeySol(world.env);
    expect(new Set(world.solana.sent).size).toBe(1);
    const swallowed = makeWorld();
    await fundedDeposit(swallowed, "swallow");
    swallowed.solana.lamportsOf.set(keyOf(swallowed), 20_000_000);
    await sweepKeySol(swallowed.env);
    expect(new Set(swallowed.solana.sent).size).toBe(2);
    expect(swallowed.rows.size).toBe(1);
  });

  it("never sends an uncertain sweep again, and replaces it only once it can never land", async () => {
    const world = makeWorld();
    await depositLeaving(world, 20_000_000);
    world.solana.swallowAll();
    await sweepKeySol(world.env);
    world.solana.clearPlans();
    expect(new Set(world.solana.sent).size).toBe(3);
    await sweepKeySol(world.env);
    await sweepKeySol(world.env);
    expect(new Set(world.solana.sent).size).toBe(3);
    expect(world.rows.size).toBe(1);
    const stale = world.record()!.id;
    world.solana.height += 400;
    await sweepKeySol(world.env);
    expect(new Set(world.solana.sent).size).toBe(4);
    expect(world.rows.has(`${world.owner}/${stale}`)).toBe(false);
    expect(world.rows.size).toBe(1);
  });

  it("skips an excess below the threshold, and sweeps one at it", async () => {
    const dust = makeWorld();
    await depositLeaving(dust, KEPT + SWEEP_MIN_LAMPORTS - 1);
    await sweepKeySol(dust.env);
    expect(new Set(dust.solana.sent).size).toBe(2);
    const enough = makeWorld();
    await depositLeaving(enough, KEPT + SWEEP_MIN_LAMPORTS);
    await sweepKeySol(enough.env);
    expect(new Set(enough.solana.sent).size).toBe(3);
  });

  it("lets Return to wallet work afterwards, from what the key kept", async () => {
    const world = makeWorld();
    await depositLeaving(world, 20_000_000);
    sweepLanding(world);
    await sweepKeySol(world.env);
    const left = world.solana.lamportsOf.get(keyOf(world))!;
    expect(left).toBe(RENT_FREE + MAX_KEY_TRANSFER_FEE_LAMPORTS);
    await sweepKeySol(world.env);
    await fundedDeposit(world, "unsent");
    world.solana.lamportsOf.set(keyOf(world), left);
    world.solana.script({
      fate: "land",
      effect: () => {
        world.solana.setToken(world.keyAccount, 0n);
        world.solana.setToken(world.wallet, world.solana.token(world.wallet) + ATOMS);
      },
    });
    const outcome = await returnToWallet(world.env, {
      intent: { id: world.record()!.id, atoms: ATOMS.toString() },
    });
    expect(outcome).toMatchObject({ status: "done", atoms: ATOMS });
  });

  describe("the shape the guard allows", () => {
    const context = (world: World) => ({
      pins: world.pins,
      owner: world.keypair.publicKey,
      token: world.token,
    });
    const sweepOf = (world: World, to = world.keypair.publicKey, lamports = 5_000_000) =>
      withComputeBudget([
        SystemProgram.transfer({
          fromPubkey: world.depositKey.publicKey,
          toPubkey: to,
          lamports,
        }),
      ]);
    const refusal = (world: World, instructions: ReturnType<typeof sweepOf>) =>
      signableRefusal(
        context(world),
        new Transaction({
          feePayer: world.depositKey.publicKey,
          blockhash: PublicKey.default.toBase58(),
          lastValidBlockHeight: 1,
        }).add(...instructions),
        { kind: "key-sweep", key: world.depositKey.publicKey, lamports: 5_000_000 },
      );

    it("accepts one transfer from the key to the owner and nothing else", async () => {
      const world = makeWorld();
      expect(await refusal(world, sweepOf(world))).toBeNull();
      expect(await refusal(world, sweepOf(world, PublicKey.unique()))).toMatch(/key-sweep/);
      expect(await refusal(world, sweepOf(world, world.keypair.publicKey, 5_000_001))).toMatch(
        /key-sweep/,
      );
      const extra = sweepOf(world);
      extra.push(...sweepOf(world).slice(2));
      expect(await refusal(world, extra)).toMatch(/key-sweep/);
    });
  });
});

describe("returning the deposit key's USDC to the wallet", () => {
  const returnFor = (world: World, id = "id1", atoms = ATOMS, answer?: string) =>
    returnToWallet(world.env, { intent: { id, atoms: atoms.toString() }, answer });
  /** What the key's payment back does when it lands: its USDC on Solana goes to the wallet. */
  const returnEffect = (world: World) => () => {
    world.solana.setToken(world.keyAccount, 0n);
    world.solana.setToken(world.wallet, world.solana.token(world.wallet) + ATOMS);
  };

  it("offers Return to wallet on a deposit whose move did not go through, next to trying it again", async () => {
    const world = makeWorld();
    await fundedDeposit(world, "unsent");
    const record = world.record()!;
    const attention = attentionOf(record, null, [record]);
    expect(attention).toMatchObject({
      staged: true,
      keyed: true,
      returnable: true,
      resumable: true,
    });
    expect(actionsOf(attention)).toEqual(expect.arrayContaining(["resume", "return"]));
  });

  it("sends the key's USDC back to the owner's token account with a payment the key alone signs, journaled first", async () => {
    const world = makeWorld();
    await fundedDeposit(world, "unsent");
    world.solana.script({ fate: "land", effect: returnEffect(world) });
    const outcome = await returnFor(world);
    expect(outcome).toMatchObject({ status: "done", id: "id1.return", atoms: ATOMS });
    expect(world.events).toEqual(["journal:record", "broadcast:solana"]);
    const sent = Transaction.from(world.solana.rawSent[world.solana.rawSent.length - 1]);
    const key = world.depositKey.publicKey;
    expect(sent.feePayer?.equals(key)).toBe(true);
    expect(sent.compileMessage().header.numRequiredSignatures).toBe(1);
    expect(sent.verifySignatures()).toBe(true);
    const [, , pay] = sent.instructions;
    expect(sent.instructions).toHaveLength(3);
    expect(pay.keys[0].pubkey.equals(depositKeyAccount(key, world.pins.mint))).toBe(true);
    expect(
      pay.keys[2].pubkey.equals(associatedTokenAddress(world.keypair.publicKey, world.pins.mint)),
    ).toBe(true);
    expect(pay.data.readBigUInt64LE(1)).toBe(ATOMS);
    expect(world.signed).toHaveLength(1);
    expect(world.solana.token(world.wallet)).toBe(100n * USDC);
    await finishCompleted(world.env);
    expect(world.rows.size).toBe(0);
  });

  it("closes nothing: it sends one payment and nothing else", async () => {
    const world = makeWorld();
    await fundedDeposit(world, "unsent");
    world.solana.script({ fate: "land", effect: returnEffect(world) });
    await returnFor(world);
    const sent = Transaction.from(world.solana.rawSent[world.solana.rawSent.length - 1]);
    expect(sent.instructions.map((each) => each.programId.toBase58())).toEqual([
      ComputeBudgetProgram.programId.toBase58(),
      ComputeBudgetProgram.programId.toBase58(),
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    ]);
    expect(sent.instructions[2].data[0]).toBe(12);
  });

  it("is offered after the move failed for good, and works when the move keeps failing", async () => {
    const world = makeWorld();
    await fundedDeposit(world, "fail");
    world.solana.script({ fate: "land", effect: returnEffect(world) });
    expect(await returnFor(world)).toMatchObject({ status: "done", atoms: ATOMS });
  });

  it("waits while the move may still land and sends nothing", async () => {
    const world = makeWorld();
    await fundedDeposit(world, "swallow");
    expect(await returnFor(world)).toMatchObject({ status: "waiting" });
    expect(world.events).toEqual([]);
    expect(new Set(world.solana.sent).size).toBe(2);
  });

  it("refuses once the move landed, since the USDC is in the rollup", async () => {
    const world = makeWorld();
    await fundedDeposit(world, "swallow");
    world.solana.statuses.set(world.record()!.sends[1].signature, finalized);
    world.moveEffect(ATOMS)();
    expect(await returnFor(world)).toMatchObject({ status: "refused", reason: "key-moved" });
    expect(world.events).toEqual([]);
  });

  it("refuses when the key shows no USDC, sending nothing", async () => {
    const world = makeWorld();
    world.solana.script({ fate: "land" });
    await deposit(world.env, { amount: AMOUNT });
    world.events.length = 0;
    expect(await returnFor(world)).toMatchObject({ status: "refused", reason: "key-empty" });
    expect(world.events).toEqual([]);
  });

  it("refuses when the payment to the key did not land", async () => {
    const world = makeWorld();
    await unlandedPayment(world);
    world.solana.height += 400;
    expect(await returnFor(world)).toMatchObject({
      status: "refused",
      reason: "nothing-to-return",
    });
    expect(world.events).toEqual([]);
  });

  it("refuses a record changed since it was shown, sending nothing", async () => {
    const world = makeWorld();
    await fundedDeposit(world, "unsent");
    expect(await returnFor(world, "id1", ATOMS + 1n)).toMatchObject({
      status: "refused",
      reason: "record-changed",
    });
    expect(world.events).toEqual([]);
  });

  it("never repeats a return whose outcome is uncertain, and resumes it from its own record", async () => {
    const world = makeWorld();
    await fundedDeposit(world, "unsent");
    world.solana.swallowAll();
    expect(await returnFor(world)).toMatchObject({ status: "waiting" });
    world.solana.clearPlans();
    const record = world.record();
    expect(world.rows.has(`${world.owner}/id1.return`)).toBe(true);
    const sentBefore = new Set(world.solana.sent).size;
    expect(await returnFor(world, "id1.return", ATOMS)).toMatchObject({ status: "waiting" });
    expect(new Set(world.solana.sent).size).toBe(sentBefore);
    expect(record).toBeDefined();
    const returnRecord = [...world.rows.values()].find((each) => each.id === "id1.return")!;
    expect(attentionOf(returnRecord, null, [...world.rows.values()])).toMatchObject({
      operation: "return",
      resumable: true,
    });
  });

  it("sends the return again only after the earlier one can never land", async () => {
    const world = makeWorld();
    await fundedDeposit(world, "unsent");
    world.solana.swallowAll();
    await returnFor(world);
    world.solana.clearPlans();
    world.solana.height += 400;
    world.solana.script({ fate: "land", effect: returnEffect(world) });
    expect(await returnFor(world, "id1.return")).toMatchObject({ status: "done", atoms: ATOMS });
    expect(new Set(world.solana.sent).size).toBe(3);
  });

  it("takes the deposit back from the list too: the deposit stays behind its return", async () => {
    const world = makeWorld();
    await fundedDeposit(world, "unsent");
    world.solana.swallowAll();
    await returnFor(world);
    world.solana.clearPlans();
    const records = [...world.rows.values()];
    const deposit = records.find((each) => each.id === "id1")!;
    expect(attentionOf(deposit, null, records)).toMatchObject({
      resumable: false,
      returnable: false,
    });
  });
});
