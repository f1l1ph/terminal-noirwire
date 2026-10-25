import { describe, expect, it } from "vitest";
import { deposit } from "@/lib/transfer/deposit";
import { withdraw } from "@/lib/transfer/withdraw";
import { USDC, makeWorld, type World } from "./transferWorld";

const ATOMS = 2_500_000n;
const AMOUNT = "2.500000";

function readyToWithdraw(): World {
  const world = makeWorld();
  world.delegate(0n);
  world.fund({ onSolana: 0n });
  world.rollup.script({ fate: "land", effect: world.seatEffect(ATOMS) });
  world.solana.script({ fate: "land", effect: world.shuttleEffect(ATOMS) });
  return world;
}

async function openRecord(world: World, landedSeat: boolean) {
  const { journal } = world.env;
  await journal.record(world.owner, {
    id: "old",
    kind: "withdraw",
    atoms: ATOMS.toString(),
    step: "withdraw",
    sends: [],
  });
  await journal.recordSeatSend(world.owner, "old", {
    state: "pending",
    at: "t",
    id: "s1",
    before: "0",
    signature: "neverSent",
    lastValidBlockHeight: world.rollup.height + 150,
  });
  if (landedSeat) {
    await journal.markSeatLanded(world.owner, "old");
    world.rollup.statuses.set("neverSent", { err: null, confirmationStatus: "finalized" });
  }
  world.events.length = 0;
}

const resume = { kind: "resume", id: "old", atoms: ATOMS.toString() } as const;

describe("a stale resume", () => {
  it("sends nothing and starts nothing when the record was finished in another tab", async () => {
    const world = readyToWithdraw();
    world.rollup.setToken(world.wallet, ATOMS);
    const outcome = await withdraw(world.env, {
      amount: AMOUNT,
      freeCollateral: 10n * USDC,
      intent: resume,
    });
    expect(outcome).toMatchObject({ status: "refused", reason: "record-changed" });
    expect(world.events).toEqual([]);
    expect(world.solana.sent).toEqual([]);
    expect(world.rollup.sent).toEqual([]);
    expect(world.rows.size).toBe(0);
  });

  it("does the same for a deposit", async () => {
    const world = makeWorld();
    world.fund({ onSolana: 10n * USDC });
    const outcome = await deposit(world.env, { amount: AMOUNT, intent: resume });
    expect(outcome).toMatchObject({ status: "refused", reason: "record-changed" });
    expect(world.solana.sent).toEqual([]);
    expect(world.rows.size).toBe(0);
  });

  it("continues only the record's current step when its step advanced", async () => {
    const world = readyToWithdraw();
    world.rollup.setToken(world.wallet, ATOMS);
    await openRecord(world, true);
    const outcome = await withdraw(world.env, {
      amount: AMOUNT,
      freeCollateral: 0n,
      intent: resume,
    });
    expect(outcome).toMatchObject({ status: "done", id: "old" });
    expect(world.rollup.sent).toEqual([]);
    expect(world.solana.sent).toHaveLength(1);
  });

  it("refuses a record of another kind or amount", async () => {
    const world = readyToWithdraw();
    await openRecord(world, true);
    const asDeposit = await deposit(world.env, { amount: AMOUNT, intent: resume });
    expect(asDeposit).toMatchObject({ status: "refused", reason: "record-changed" });
    const otherAmount = await withdraw(world.env, {
      amount: AMOUNT,
      freeCollateral: 0n,
      intent: { ...resume, atoms: "1" },
    });
    expect(otherAmount).toMatchObject({ status: "refused", reason: "record-changed" });
    expect(world.solana.sent).toEqual([]);
    expect(world.rollup.sent).toEqual([]);
  });
});

describe("a new transfer after a record appeared", () => {
  it("is refused, sending nothing, when a record appeared since the form was shown", async () => {
    const world = readyToWithdraw();
    await openRecord(world, false);
    const outcome = await withdraw(world.env, {
      amount: AMOUNT,
      freeCollateral: 10n * USDC,
      intent: { kind: "new" },
    });
    expect(outcome).toMatchObject({ status: "refused", reason: "unfinished-operation" });
    expect(world.events).toEqual([]);
    expect(world.solana.sent).toEqual([]);
    expect(world.rollup.sent).toEqual([]);
    expect(world.rows.size).toBe(1);
  });

  it("goes ahead when no record is open", async () => {
    const world = readyToWithdraw();
    const outcome = await withdraw(world.env, {
      amount: AMOUNT,
      freeCollateral: 10n * USDC,
      intent: { kind: "new" },
    });
    expect(outcome).toMatchObject({ status: "done" });
  });
});
