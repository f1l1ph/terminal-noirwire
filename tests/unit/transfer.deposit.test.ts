import { describe, expect, it } from "vitest";
import { Connection } from "@solana/web3.js";
import { deposit } from "@/lib/transfer/deposit";
import { dismissRollupSend } from "@/lib/transfer/dismiss";
import { ROUND_TRIP_LAMPORTS } from "@/lib/transfer/operation";
import type { SolanaRpc } from "@/lib/transfer/solanaRpc";
import { tryLockOwner } from "@/lib/transfer/lock";
import { USDC, makeWorld, type World } from "./transferWorld";

const ATOMS = 2_500_000n;
const AMOUNT = "2.5";

/** A deposit whose two steps both land. */
function landing(world: World) {
  world.solana.script({ fate: "land", effect: world.moveEffect(ATOMS) });
  world.rollup.script({ fate: "land", effect: world.depositEffect(ATOMS) });
}

/** Writes down a delegation that was sent, as an earlier run would have. */
async function earlierMove(world: World, signature = "sigA") {
  await world.env.journal.record(world.owner, {
    id: "old",
    kind: "deposit",
    atoms: ATOMS.toString(),
    step: "deposit",
    rollupBefore: "0",
    sends: [
      {
        signature,
        lastValidBlockHeight: world.solana.height + 150,
        before: (100n * USDC).toString(),
        moved: ATOMS.toString(),
      },
    ],
  });
  world.events.length = 0;
}

describe("deposit preconditions", () => {
  it("accepts a real connection as the node", () => {
    const check = (connection: Connection): SolanaRpc => connection;
    expect(check).toBeTypeOf("function");
  });

  it("refuses a deposit that takes custody past its cap, before any signature", async () => {
    const world = makeWorld();
    world.exchange.custodyCap = 10n * USDC;
    world.fund({ onSolana: 100n * USDC, inCustody: 10n * USDC - ATOMS + 1n });
    const outcome = await deposit(world.env, { amount: AMOUNT });
    expect(outcome).toMatchObject({ status: "refused", reason: "custody-cap" });
    expect(world.events).toEqual([]);
    expect(world.rows.size).toBe(0);
  });

  it("allows a deposit that takes custody exactly to its cap", async () => {
    const world = makeWorld();
    world.exchange.custodyCap = 10n * USDC;
    world.fund({ onSolana: 100n * USDC, inCustody: 10n * USDC - ATOMS });
    landing(world);
    const outcome = await deposit(world.env, { amount: AMOUNT });
    expect(outcome).toMatchObject({ status: "done", atoms: ATOMS });
  });

  it("leaves the cap to the program when the rollup does not serve custody", async () => {
    const world = makeWorld();
    world.rollup.accounts.delete(world.custody.toBase58());
    landing(world);
    const outcome = await deposit(world.env, { amount: AMOUNT });
    expect(outcome).toMatchObject({ status: "done", atoms: ATOMS });
  });

  it("refuses when the wallet holds less SOL than the steps cost, before any signature", async () => {
    const world = makeWorld();
    world.solana.lamports = ROUND_TRIP_LAMPORTS - 1;
    const outcome = await deposit(world.env, { amount: AMOUNT });
    expect(outcome).toMatchObject({ status: "refused", reason: "insufficient-sol" });
    expect(world.events).toEqual([]);
  });

  it("refuses when the wallet holds fewer tokens than asked, before any signature", async () => {
    const world = makeWorld();
    world.fund({ onSolana: ATOMS - 1n });
    const outcome = await deposit(world.env, { amount: AMOUNT });
    expect(outcome).toMatchObject({ status: "refused", reason: "insufficient-usdc" });
    expect(world.events).toEqual([]);
  });

  it("refuses when the account is not open or the exchange is paused", async () => {
    const closed = makeWorld();
    closed.exchange.open = false;
    expect(await deposit(closed.env, { amount: AMOUNT })).toMatchObject({
      reason: "account-not-open",
    });
    const paused = makeWorld();
    paused.exchange.paused = true;
    expect(await deposit(paused.env, { amount: AMOUNT })).toMatchObject({
      reason: "exchange-paused",
    });
    expect([...closed.events, ...paused.events]).toEqual([]);
  });

  it("refuses an amount the token cannot hold without rounding it", async () => {
    const world = makeWorld();
    const outcome = await deposit(world.env, { amount: "0.0000001" });
    expect(outcome).toMatchObject({ status: "refused", reason: "invalid-amount" });
    expect(world.events).toEqual([]);
  });
});

describe("deposit steps", () => {
  it("moves the tokens into the seat and hands back to sync the view", async () => {
    const world = makeWorld();
    landing(world);
    const outcome = await deposit(world.env, { amount: AMOUNT });
    expect(outcome).toEqual({ status: "done", id: "id1", atoms: ATOMS, next: "syncView" });
    expect(world.solana.token(world.wallet)).toBe(100n * USDC - ATOMS);
    expect(world.rollup.token(world.wallet)).toBe(0n);
    expect(new Set(world.rollup.sent).size).toBe(1);
    expect(world.rows.size).toBe(0);
  });

  it("writes each send to the journal after it is signed and before it is broadcast", async () => {
    const world = makeWorld();
    landing(world);
    await deposit(world.env, { amount: AMOUNT });
    expect(world.events).toEqual([
      "sign",
      "journal:record",
      "broadcast:solana",
      "sign",
      "journal:seat",
      "broadcast:rollup",
    ]);
  });

  it("resumes after the move landed by sending only the deposit", async () => {
    const world = makeWorld();
    await earlierMove(world);
    world.solana.statuses.set("sigA", { err: null, confirmationStatus: "finalized" });
    world.delegate(ATOMS);
    world.solana.setToken(world.wallet, 100n * USDC - ATOMS);
    world.rollup.script({ fate: "land", effect: world.depositEffect(ATOMS) });
    const outcome = await deposit(world.env, { amount: AMOUNT });
    expect(outcome).toMatchObject({ status: "done", id: "old" });
    expect(world.solana.sent).toEqual([]);
    expect(world.rollup.sent).toHaveLength(1);
  });

  it("sends nothing while the move may still land", async () => {
    const world = makeWorld();
    await earlierMove(world);
    const outcome = await deposit(world.env, { amount: AMOUNT });
    expect(outcome).toMatchObject({ status: "waiting", id: "old" });
    expect(world.events).toEqual([]);
  });

  it("does not deposit again when the seat step is on record and its status shows success", async () => {
    const world = makeWorld();
    await earlierMove(world);
    world.solana.statuses.set("sigA", { err: null, confirmationStatus: "finalized" });
    world.delegate(0n);
    await world.env.journal.recordSeatSend(world.owner, "old", {
      state: "pending",
      at: "t",
      id: "s1",
      before: ATOMS.toString(),
      signature: "sigR",
      lastValidBlockHeight: world.rollup.height + 150,
    });
    world.rollup.statuses.set("sigR", { err: null, confirmationStatus: "finalized" });
    const outcome = await deposit(world.env, { amount: AMOUNT });
    expect(outcome).toMatchObject({ status: "done", id: "old" });
    expect(world.rollup.sent).toEqual([]);
    expect(world.rows.size).toBe(0);
  });

  it("reports a confirmed success as done but keeps the record until it is finalized", async () => {
    const world = makeWorld();
    world.solana.script({ fate: "land", effect: world.moveEffect(ATOMS) });
    world.rollup.script({ fate: "swallow" });
    await deposit(world.env, { amount: AMOUNT });
    const signature = world.rollup.sent[0];
    world.rollup.statuses.set(signature, { err: null, confirmationStatus: "confirmed" });
    expect(await deposit(world.env, { amount: AMOUNT })).toMatchObject({ status: "done" });
    expect(world.rows.size).toBe(1);
    expect(await deposit(world.env, { amount: "1" })).toMatchObject({
      reason: "unfinished-operation",
    });
    world.rollup.statuses.set(signature, { err: null, confirmationStatus: "finalized" });
    world.solana.script({ fate: "swallow" });
    await deposit(world.env, { amount: "1" });
    expect(world.rows.has(`${world.owner}/id1`)).toBe(false);
    expect(new Set(world.rollup.sent).size).toBe(1);
  });

  it("records the rollup send's signature and expiry before it is broadcast", async () => {
    const world = makeWorld();
    world.solana.script({ fate: "land", effect: world.moveEffect(ATOMS) });
    world.rollup.script({ fate: "swallow" });
    await deposit(world.env, { amount: AMOUNT });
    expect(world.record()?.seat).toMatchObject({
      state: "pending",
      signature: world.rollup.sent[0],
      lastValidBlockHeight: world.rollup.height + 150,
    });
  });

  it("never resends: pending waits, expired reports it did not go through, and only a dismissal by hand frees a new try", async () => {
    const world = makeWorld();
    world.solana.script({ fate: "land", effect: world.moveEffect(ATOMS) });
    world.rollup.script({ fate: "swallow" });
    expect(await deposit(world.env, { amount: AMOUNT })).toMatchObject({ status: "waiting" });
    const seat = world.record()?.seat;
    for (const answer of [undefined, `lost:${seat?.id}`, `landed:${seat?.id}`]) {
      const outcome = await deposit(world.env, { amount: AMOUNT, answer });
      expect(outcome).toMatchObject({ status: "waiting" });
    }
    expect(await dismissRollupSend(world.env)).toMatchObject({ reason: "not-dismissable" });

    world.rollup.height += 200;
    for (let call = 0; call < 2; call += 1) {
      expect(await deposit(world.env, { amount: AMOUNT })).toMatchObject({
        status: "not-landed",
        signature: world.rollup.sent[0],
      });
    }
    expect(new Set(world.rollup.sent).size).toBe(1);

    expect(await dismissRollupSend(world.env)).toMatchObject({ status: "dismissed" });
    expect(new Set(world.rollup.sent).size).toBe(1);
    world.rollup.script({ fate: "land", effect: world.depositEffect(ATOMS) });
    expect(await deposit(world.env, { amount: AMOUNT })).toMatchObject({ status: "done" });
    expect(new Set(world.rollup.sent).size).toBe(2);
    expect(world.rollup.token(world.wallet)).toBe(0n);
  });

  it("does not take a balance change for proof that the deposit landed", async () => {
    const world = makeWorld();
    world.solana.script({ fate: "land", effect: world.moveEffect(ATOMS) });
    world.rollup.script({ fate: "swallow" });
    await deposit(world.env, { amount: AMOUNT });
    world.depositEffect(ATOMS)();
    expect(await deposit(world.env, { amount: AMOUNT })).toMatchObject({ status: "waiting" });
    world.rollup.height += 200;
    expect(await deposit(world.env, { amount: AMOUNT })).toMatchObject({ status: "not-landed" });
    expect(world.record()).toBeDefined();
    expect(new Set(world.rollup.sent).size).toBe(1);
  });

  it("finds an original that landed late by its status", async () => {
    const world = makeWorld();
    world.solana.script({ fate: "land", effect: world.moveEffect(ATOMS) });
    world.rollup.script({ fate: "swallow" });
    await deposit(world.env, { amount: AMOUNT });
    world.rollup.statuses.set(world.rollup.sent[0], { err: null, confirmationStatus: "finalized" });
    expect(await deposit(world.env, { amount: AMOUNT })).toMatchObject({ status: "done" });
    expect(new Set(world.rollup.sent).size).toBe(1);
    expect(world.rows.size).toBe(0);
  });

  it("keeps waiting on an error that is only confirmed, since it may still be rolled back", async () => {
    const world = makeWorld();
    world.solana.script({ fate: "land", effect: world.moveEffect(ATOMS) });
    world.rollup.script({ fate: "swallow" });
    await deposit(world.env, { amount: AMOUNT });
    world.rollup.statuses.set(world.rollup.sent[0], {
      err: { InstructionError: [0, { Custom: 6150 }] },
      confirmationStatus: "confirmed",
    });
    world.rollup.height += 200;
    expect(await deposit(world.env, { amount: AMOUNT })).toMatchObject({ status: "waiting" });
    expect(world.record()?.seat?.state).toBe("pending");
    expect(new Set(world.rollup.sent).size).toBe(1);
  });

  it("clears an original whose status shows an error, strands the tokens, and sends nothing itself", async () => {
    const world = makeWorld();
    world.solana.script({ fate: "land", effect: world.moveEffect(ATOMS) });
    world.rollup.script({ fate: "swallow" });
    await deposit(world.env, { amount: AMOUNT });
    world.rollup.statuses.set(world.rollup.sent[0], {
      err: { InstructionError: [0, { Custom: 6150 }] },
      confirmationStatus: "finalized",
    });
    expect(await deposit(world.env, { amount: AMOUNT })).toMatchObject({ status: "stranded" });
    expect(world.record()?.seat).toBeUndefined();
    expect(new Set(world.rollup.sent).size).toBe(1);
  });

  it("treats a crash between the record and the send like any send: waits, reports, never rebuilds on its own", async () => {
    const world = makeWorld();
    await earlierMove(world);
    world.solana.statuses.set("sigA", { err: null, confirmationStatus: "finalized" });
    world.delegate(ATOMS);
    await world.env.journal.recordSeatSend(world.owner, "old", {
      state: "pending",
      at: "t",
      id: "s1",
      before: ATOMS.toString(),
      signature: "neverSent",
      lastValidBlockHeight: world.rollup.height + 150,
    });
    expect(await deposit(world.env, { amount: AMOUNT })).toMatchObject({ status: "waiting" });
    expect(world.rollup.sent).toEqual([]);
    world.rollup.height += 200;
    expect(await deposit(world.env, { amount: AMOUNT })).toMatchObject({ status: "not-landed" });
    expect(world.rollup.sent).toEqual([]);
  });

  it("shows the signature and sends nothing when a send cannot be placed", async () => {
    const world = makeWorld();
    await earlierMove(world);
    world.solana.statuses.set("sigA", { err: null, confirmationStatus: "finalized" });
    world.delegate(ATOMS);
    await world.env.journal.recordSeatSend(world.owner, "old", {
      state: "pending",
      at: "t",
      id: "s1",
      before: ATOMS.toString(),
    });
    const legacy = await deposit(world.env, { amount: AMOUNT });
    expect(legacy).toMatchObject({ status: "unknown", subject: "rollup-send", answers: [] });

    const moved = makeWorld();
    await earlierMove(moved);
    moved.solana.statuses.set("sigA", { err: null, confirmationStatus: "finalized" });
    moved.delegate(ATOMS + 5n);
    await moved.env.journal.recordSeatSend(moved.owner, "old", {
      state: "pending",
      at: "t",
      id: "s1",
      before: ATOMS.toString(),
      signature: "sigR",
      lastValidBlockHeight: moved.rollup.height + 150,
    });
    moved.rollup.getSignatureStatus = async () => {
      throw new Error("endpoint down");
    };
    expect(await deposit(moved.env, { amount: AMOUNT })).toMatchObject({
      status: "unknown",
      signature: "sigR",
      answers: [],
    });
    moved.rollup.height += 200;
    expect(await dismissRollupSend(moved.env)).toMatchObject({ reason: "not-dismissable" });
    expect(moved.record()?.seat?.state).toBe("pending");
    expect([...world.rollup.sent, ...moved.rollup.sent]).toEqual([]);
  });

  it("refuses a different amount while an earlier deposit is unfinished", async () => {
    const world = makeWorld();
    await earlierMove(world);
    const outcome = await deposit(world.env, { amount: "1" });
    expect(outcome).toMatchObject({ status: "refused", reason: "unfinished-operation" });
    expect(world.events).toEqual([]);
  });

  it("strands the tokens in the rollup balance when the deposit is refused, and retries from there", async () => {
    const world = makeWorld();
    world.solana.script({ fate: "land", effect: world.moveEffect(ATOMS) });
    world.rollup.script({ fate: "fail" });
    const stranded = await deposit(world.env, { amount: AMOUNT });
    expect(stranded).toMatchObject({ status: "stranded" });
    expect(world.rollup.token(world.wallet)).toBe(ATOMS);
    expect(world.record()?.seat).toBeUndefined();
    world.rollup.script({ fate: "land", effect: world.depositEffect(ATOMS) });
    const retried = await deposit(world.env, { amount: AMOUNT });
    expect(retried).toMatchObject({ status: "done" });
    expect(world.solana.sent).toHaveLength(1);
  });

  it("does not send a second move when the first send's answer was lost", async () => {
    const world = makeWorld();
    world.solana.script({ fate: "land-lost", effect: world.moveEffect(ATOMS) });
    world.rollup.script({ fate: "land", effect: world.depositEffect(ATOMS) });
    const outcome = await deposit(world.env, { amount: AMOUNT });
    expect(outcome).toMatchObject({ status: "done" });
    expect(world.solana.sent).toHaveLength(1);
  });

  it("is blocked while another tab holds the owner's lock", async () => {
    const world = makeWorld();
    landing(world);
    const other = await tryLockOwner(world.owner, world.locks);
    expect(other).not.toBeNull();
    expect(await deposit(world.env, { amount: AMOUNT })).toEqual({ status: "busy" });
    expect(world.events).toEqual([]);
    other?.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await deposit(world.env, { amount: AMOUNT })).toMatchObject({ status: "done" });
  });
});
