import { describe, expect, it } from "vitest";
import { dismissRollupSend } from "@/lib/transfer/dismiss";
import { tryLockOwner } from "@/lib/transfer/lock";
import { SOLANA_EXIT_LAMPORTS } from "@/lib/transfer/operation";
import { withdraw } from "@/lib/transfer/withdraw";
import { USDC, makeWorld, staleMark, type World } from "./transferWorld";

const ATOMS = 2_500_000n;
const AMOUNT = "2.5";
const FREE = 5n * USDC;

const ask = (world: World, extra: { free?: bigint; answer?: string } = {}) =>
  withdraw(world.env, {
    amount: AMOUNT,
    freeCollateral: extra.free ?? FREE,
    answer: extra.answer,
  });

/** A seat with an account shown in the rollup, and a withdrawal whose two steps both land. */
function readyToWithdraw(): World {
  const world = makeWorld();
  world.delegate(0n);
  world.fund({ onSolana: 0n });
  world.rollup.script({ fate: "land", effect: world.seatEffect(ATOMS) });
  world.solana.script({ fate: "land", effect: world.shuttleEffect(ATOMS) });
  return world;
}

/** An earlier run that got as far as the seat's withdrawal having landed, then stopped. */
async function earlierSeatStep(world: World, state: "pending" | "landed", signed = true) {
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
    ...(signed ? { signature: "neverSent", lastValidBlockHeight: world.rollup.height + 150 } : {}),
  });
  if (state === "landed") {
    await journal.markSeatLanded(world.owner, "old");
    world.rollup.statuses.set("neverSent", { err: null, confirmationStatus: "finalized" });
  }
  world.events.length = 0;
}

describe("withdraw preconditions", () => {
  it("refuses an amount above the free collateral, before any signature", async () => {
    const world = readyToWithdraw();
    const outcome = await ask(world, { free: ATOMS - 1n });
    expect(outcome).toMatchObject({ status: "refused", reason: "above-free-collateral" });
    expect(world.events).toEqual([]);
    expect(world.rows.size).toBe(0);
  });

  it("allows an amount equal to the free collateral", async () => {
    const world = readyToWithdraw();
    expect(await ask(world, { free: ATOMS })).toMatchObject({ status: "done" });
  });

  it("refuses when the wallet holds less SOL than the exit costs, before any signature", async () => {
    const world = readyToWithdraw();
    world.solana.lamports = SOLANA_EXIT_LAMPORTS - 1;
    const outcome = await ask(world);
    expect(outcome).toMatchObject({ status: "refused", reason: "insufficient-sol" });
    expect(world.events).toEqual([]);
  });

  it("refuses an amount of nothing", async () => {
    const world = readyToWithdraw();
    const outcome = await withdraw(world.env, { amount: "0", freeCollateral: FREE });
    expect(outcome).toMatchObject({ status: "refused", reason: "invalid-amount" });
    expect(world.events).toEqual([]);
  });
});

describe("withdraw steps", () => {
  it("pays the seat out to the wallet, writing each send down before it is broadcast", async () => {
    const world = readyToWithdraw();
    const outcome = await ask(world);
    expect(outcome).toMatchObject({ status: "done", atoms: ATOMS });
    expect(world.solana.token(world.wallet)).toBe(ATOMS);
    expect(world.rollup.token(world.wallet)).toBe(0n);
    expect(world.exchange.withdrawBuilds).toBe(1);
    expect(world.events).toEqual([
      "journal:record",
      "sign",
      "journal:seat",
      "broadcast:rollup",
      "sign",
      "journal:record",
      "broadcast:solana",
    ]);
    expect(world.rows.size).toBe(0);
  });

  it("waits out a stale price and then withdraws", async () => {
    const world = readyToWithdraw();
    world.rollup.simulateAnswers.push(staleMark, staleMark);
    const outcome = await ask(world);
    expect(outcome).toMatchObject({ status: "done" });
    expect(world.rollup.simulations).toBe(3);
    expect(world.exchange.withdrawBuilds).toBe(1);
  });

  it("gives up on a stale price after 240 seconds, signing nothing", async () => {
    const world = readyToWithdraw();
    world.rollup.simulateAnswers.push(...Array.from({ length: 100 }, () => staleMark));
    const started = world.clock.now();
    const outcome = await ask(world);
    const waited = world.clock.now() - started;
    expect(outcome).toMatchObject({ status: "refused", reason: "stale-price" });
    expect(waited).toBeGreaterThanOrEqual(240_000);
    expect(waited).toBeLessThan(260_000);
    expect(world.events).not.toContain("sign");
    expect(world.rollup.sent).toEqual([]);
    expect(world.solana.sent).toEqual([]);
  });

  it("does not send a withdrawal the program would refuse for another reason", async () => {
    const world = readyToWithdraw();
    world.rollup.simulateAnswers.push({ InstructionError: [0, { Custom: 6001 }] });
    const outcome = await ask(world);
    expect(outcome).toMatchObject({ status: "refused", reason: "rollup-refused" });
    expect(world.rollup.simulations).toBe(1);
    expect(world.events).not.toContain("sign");
  });

  it("sends only the Solana step when the seat's withdrawal is on record as landed", async () => {
    const world = readyToWithdraw();
    world.rollup.setToken(world.wallet, ATOMS);
    await earlierSeatStep(world, "landed");
    const outcome = await ask(world);
    expect(outcome).toMatchObject({ status: "done", id: "old" });
    expect(world.rollup.sent).toEqual([]);
    expect(world.exchange.withdrawBuilds).toBe(0);
    expect(world.solana.sent).toHaveLength(1);
    expect(world.solana.token(world.wallet)).toBe(ATOMS);
  });

  it("sends only the Solana step when the seat withdrawal's status shows success", async () => {
    const world = readyToWithdraw();
    world.rollup.setToken(world.wallet, ATOMS);
    await earlierSeatStep(world, "pending");
    world.rollup.statuses.set("neverSent", { err: null, confirmationStatus: "finalized" });
    const outcome = await ask(world);
    expect(outcome).toMatchObject({ status: "done", id: "old" });
    expect(world.rollup.sent).toEqual([]);
    expect(world.solana.sent).toHaveLength(1);
  });

  it("waits instead of sending when a reload finds a seat withdrawal that may still land", async () => {
    const world = readyToWithdraw();
    await earlierSeatStep(world, "pending");
    const outcome = await ask(world);
    expect(outcome).toMatchObject({ status: "waiting", id: "old" });
    expect(world.exchange.withdrawBuilds).toBe(0);
    expect(world.events).toEqual([]);
  });

  it("records the rollup send's signature and expiry before it is broadcast", async () => {
    const world = makeWorld();
    world.delegate(0n);
    world.rollup.script({ fate: "swallow" });
    await ask(world);
    expect(world.record()?.seat).toMatchObject({
      state: "pending",
      signature: world.rollup.sent[0],
      lastValidBlockHeight: world.rollup.height + 150,
    });
    expect(world.events.indexOf("journal:seat")).toBeLessThan(
      world.events.indexOf("broadcast:rollup"),
    );
  });

  it("never resends: pending waits, expired reports it did not go through, and only a dismissal by hand frees a new try", async () => {
    const world = makeWorld();
    world.delegate(0n);
    world.rollup.script({ fate: "swallow" });
    expect(await ask(world)).toMatchObject({ status: "waiting" });
    const seat = world.record()?.seat;
    for (const answer of [undefined, `lost:${seat?.id}`, `landed:${seat?.id}`]) {
      expect(await ask(world, { answer })).toMatchObject({ status: "waiting" });
    }
    expect(new Set(world.rollup.sent).size).toBe(1);
    expect(world.exchange.withdrawBuilds).toBe(1);
    expect(await dismissRollupSend(world.env)).toMatchObject({ reason: "not-dismissable" });

    world.rollup.height += 200;
    for (let call = 0; call < 2; call += 1) {
      expect(await ask(world)).toMatchObject({
        status: "not-landed",
        signature: world.rollup.sent[0],
      });
    }
    expect(new Set(world.rollup.sent).size).toBe(1);

    expect(await dismissRollupSend(world.env)).toMatchObject({ status: "dismissed" });
    expect(new Set(world.rollup.sent).size).toBe(1);
    world.rollup.script({ fate: "land", effect: world.seatEffect(ATOMS) });
    world.solana.script({ fate: "land", effect: world.shuttleEffect(ATOMS) });
    expect(await ask(world)).toMatchObject({ status: "done" });
    expect(new Set(world.rollup.sent).size).toBe(2);
  });

  it("does not take a balance change for proof that the withdrawal landed", async () => {
    const world = makeWorld();
    world.delegate(0n);
    world.rollup.script({ fate: "swallow" });
    await ask(world);
    world.seatEffect(ATOMS)();
    expect(await ask(world)).toMatchObject({ status: "waiting" });
    world.rollup.height += 200;
    expect(await ask(world)).toMatchObject({ status: "not-landed" });
    expect(world.solana.sent).toEqual([]);
    expect(new Set(world.rollup.sent).size).toBe(1);
  });

  it("clears an original whose status shows an error and sends nothing itself", async () => {
    const world = makeWorld();
    world.delegate(0n);
    world.rollup.script({ fate: "swallow" });
    await ask(world);
    world.rollup.statuses.set(world.rollup.sent[0], {
      err: { InstructionError: [0, { Custom: 6001 }] },
      confirmationStatus: "confirmed",
    });
    expect(await ask(world)).toMatchObject({ status: "waiting" });
    expect(world.record()?.seat?.state).toBe("pending");
    world.rollup.statuses.set(world.rollup.sent[0], {
      err: { InstructionError: [0, { Custom: 6001 }] },
      confirmationStatus: "finalized",
    });
    expect(await ask(world)).toMatchObject({ status: "refused", reason: "rollup-refused" });
    expect(world.record()?.seat).toBeUndefined();
    expect(new Set(world.rollup.sent).size).toBe(1);
  });

  it("finds an original that landed late by its status and sends only the Solana step", async () => {
    const world = makeWorld();
    world.delegate(0n);
    world.rollup.script({ fate: "swallow" });
    await ask(world);
    world.seatEffect(ATOMS)();
    world.rollup.statuses.set(world.rollup.sent[0], { err: null, confirmationStatus: "finalized" });
    world.solana.script({ fate: "land", effect: world.shuttleEffect(ATOMS) });
    expect(await ask(world)).toMatchObject({ status: "done" });
    expect(new Set(world.rollup.sent).size).toBe(1);
    expect(world.exchange.withdrawBuilds).toBe(1);
  });

  it("treats a crash between the record and the send like any send: waits, reports, never rebuilds on its own", async () => {
    const world = readyToWithdraw();
    await earlierSeatStep(world, "pending");
    expect(await ask(world)).toMatchObject({ status: "waiting" });
    expect(world.rollup.sent).toEqual([]);
    world.rollup.height += 200;
    expect(await ask(world)).toMatchObject({ status: "not-landed" });
    expect(world.rollup.sent).toEqual([]);
    expect(world.exchange.withdrawBuilds).toBe(0);
  });

  it("does not start the Solana leg while the seat send is confirmed but not finalized", async () => {
    const world = makeWorld();
    world.delegate(0n);
    world.rollup.script({ fate: "swallow" });
    await ask(world);
    const signature = world.rollup.sent[0];
    world.seatEffect(ATOMS)();
    world.rollup.statuses.set(signature, { err: null, confirmationStatus: "confirmed" });
    expect(await ask(world)).toMatchObject({ status: "waiting" });
    expect(world.solana.sent).toEqual([]);
    world.rollup.statuses.set(signature, { err: null, confirmationStatus: "finalized" });
    world.solana.script({ fate: "land", effect: world.shuttleEffect(ATOMS) });
    expect(await ask(world)).toMatchObject({ status: "done" });
    expect(world.solana.sent.length).toBeGreaterThan(0);
  });

  it("leaves the record and starts nothing when a confirmed seat send reverts before it is finalized", async () => {
    const world = makeWorld();
    world.delegate(0n);
    world.rollup.script({ fate: "swallow" });
    await ask(world);
    const signature = world.rollup.sent[0];
    world.seatEffect(ATOMS)();
    world.rollup.statuses.set(signature, { err: null, confirmationStatus: "confirmed" });
    expect(await ask(world)).toMatchObject({ status: "waiting" });
    world.rollup.statuses.delete(signature);
    world.rollup.height += 200;
    expect(await ask(world)).toMatchObject({ status: "waiting" });
    expect(world.solana.sent).toEqual([]);
    expect(new Set(world.rollup.sent).size).toBe(1);
    expect(world.record()?.seat?.state).toBe("landed");
  });

  it("keeps the record until both legs are finalized", async () => {
    const world = makeWorld();
    world.delegate(0n);
    world.rollup.script({ fate: "land", effect: world.seatEffect(ATOMS) });
    world.solana.script({
      fate: "land",
      effect: world.shuttleEffect(ATOMS),
      commitment: "confirmed",
    });
    expect(await ask(world)).toMatchObject({ status: "waiting" });
    expect(world.record()).toBeDefined();
    world.solana.statuses.set(world.solana.sent[0], { err: null, confirmationStatus: "finalized" });
    expect(await ask(world)).toMatchObject({ status: "done" });
    expect(world.rows.size).toBe(0);
    expect(new Set(world.solana.sent).size).toBe(1);
  });

  it("dismisses nothing when nothing is on record", async () => {
    const world = readyToWithdraw();
    expect(await dismissRollupSend(world.env)).toMatchObject({ reason: "nothing-to-dismiss" });
  });

  it("stops with no answer to give when the send has no signature on record", async () => {
    const world = readyToWithdraw();
    await earlierSeatStep(world, "pending", false);
    const outcome = await ask(world, { answer: "lost:s1" });
    expect(outcome).toMatchObject({ status: "unknown", subject: "rollup-send", answers: [] });
    expect(world.rollup.sent).toEqual([]);
  });

  it("clears a withdrawal the rollup refused, so a retry is allowed", async () => {
    const world = makeWorld();
    world.delegate(0n);
    world.rollup.script({ fate: "fail" });
    const refused = await ask(world);
    expect(refused).toMatchObject({ status: "refused", reason: "rollup-refused" });
    expect(world.record()?.seat).toBeUndefined();
  });

  it("never resends a Solana send that was seen as processed and is now missing", async () => {
    const world = readyToWithdraw();
    world.rollup.setToken(world.wallet, ATOMS);
    await earlierSeatStep(world, "landed");
    await world.env.journal.record(world.owner, {
      id: "old",
      kind: "withdraw",
      atoms: ATOMS.toString(),
      step: "withdraw",
      sends: [
        {
          signature: "sigS",
          lastValidBlockHeight: world.solana.height + 150,
          status: "processed",
          before: "0",
          moved: ATOMS.toString(),
        },
      ],
    });
    world.solana.height += 10_000;
    for (const answer of [undefined, "lost:sigS"]) {
      const outcome = await ask(world, { answer });
      expect(outcome).toMatchObject({
        status: "unknown",
        subject: "solana-send",
        answers: ["landed:sigS"],
      });
    }
    expect(world.solana.sent).toEqual([]);
  });

  it("checks only the arrival of a Solana send that landed, and sends nothing", async () => {
    const world = readyToWithdraw();
    await earlierSeatStep(world, "landed");
    await world.env.journal.record(world.owner, {
      id: "old",
      kind: "withdraw",
      atoms: ATOMS.toString(),
      step: "withdraw",
      sends: [
        {
          signature: "sigS",
          lastValidBlockHeight: world.solana.height + 150,
          before: "0",
          moved: ATOMS.toString(),
        },
      ],
    });
    world.solana.statuses.set("sigS", { err: null, confirmationStatus: "finalized" });
    const short = await ask(world);
    expect(short).toMatchObject({ status: "waiting", id: "old" });
    expect(world.record()).toBeDefined();
    world.solana.setToken(world.wallet, ATOMS);
    const arrived = await ask(world);
    expect(arrived).toMatchObject({ status: "done", id: "old", signature: "sigS" });
    expect(world.solana.sent).toEqual([]);
    expect(world.rows.size).toBe(0);
  });

  it("makes the owner's token account in the rollup first when it is missing", async () => {
    const world = makeWorld();
    world.fund({ onSolana: 0n });
    world.solana.script(
      { fate: "land", effect: () => world.delegate(0n) },
      { fate: "land", effect: world.shuttleEffect(ATOMS) },
    );
    world.rollup.script({ fate: "land", effect: world.seatEffect(ATOMS) });
    const outcome = await ask(world);
    expect(outcome).toMatchObject({ status: "done" });
    expect(world.solana.sent).toHaveLength(2);
    expect(world.events.indexOf("broadcast:solana")).toBeLessThan(
      world.events.indexOf("broadcast:rollup"),
    );
    expect(world.solana.token(world.wallet)).toBe(ATOMS);
  });

  it("will not make a token account for a sealed custody", async () => {
    const world = makeWorld();
    world.env.sealed = true;
    const outcome = await ask(world);
    expect(outcome).toMatchObject({ status: "refused", reason: "sealed-balance-missing" });
    expect(world.events).not.toContain("sign");
  });

  it("refuses a balance delegated to another validator", async () => {
    const world = makeWorld();
    world.delegate(0n, world.env.owner);
    const outcome = await ask(world);
    expect(outcome).toMatchObject({ status: "refused", reason: "delegated-elsewhere" });
    expect(world.events).not.toContain("sign");
  });

  it("is blocked while another tab holds the owner's lock", async () => {
    const world = readyToWithdraw();
    const held = await tryLockOwner(world.owner, world.locks);
    expect(await ask(world)).toEqual({ status: "busy" });
    expect(world.events).toEqual([]);
    held?.release();
  });
});
