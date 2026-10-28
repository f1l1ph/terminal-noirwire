import { describe, expect, it } from "vitest";
import { actionsOf, attentionOf, awaitsFinality } from "@/lib/transfer/attention";
import { deposit, recoverDepositKey } from "@/lib/transfer/deposit";
import { outcomeLine } from "@/lib/transfer/outcomeCopy";
import { finishCompleted } from "@/lib/transfer/withdraw";
import { makeWorld, type World } from "./transferWorld";

const ATOMS = 2_500_000n;
const AMOUNT = "2.5";

/** A deposit whose move into the rollup is only confirmed when the program refuses the last step. */
async function refusedWhileConfirmed() {
  const world = makeWorld();
  world.stagedLanding(ATOMS, "confirmed");
  world.rollup.script({ fate: "fail" });
  const outcome = await deposit(world.env, { amount: AMOUNT, intent: { kind: "new" } });
  return { world, outcome };
}

const finalize = (world: World) => {
  for (const send of world.record()!.sends) {
    world.solana.statuses.set(send.signature, { err: null, confirmationStatus: "finalized" });
  }
};

describe("a deposit the program refused while its move into the rollup is only confirmed", () => {
  it("keeps the record, marked stranded, with the Solana evidence", async () => {
    const { world, outcome } = await refusedWhileConfirmed();
    expect(outcome).toMatchObject({ status: "stranded", recordKept: true });
    const record = world.record()!;
    expect(record.stranded).toBe(true);
    expect(record.seat).toBeUndefined();
    expect(record.sends.map((send) => send.leg)).toEqual(["fund", "move"]);
    expect(record.sends[1]).toMatchObject({ moved: ATOMS.toString() });
    expect(awaitsFinality(record)).toBe(true);
  });

  it("offers the key's balance recovery from that state, named after the button that is there", async () => {
    const { world, outcome } = await refusedWhileConfirmed();
    expect(outcomeLine("deposit", outcome, 6, 1).text).toContain('"Try the deposit again"');
    const record = world.record()!;
    const attention = attentionOf(record, null, [record]);
    expect(attention).toMatchObject({ stranded: true, keyed: true, resumable: true });
    expect(actionsOf(attention)).toContain("resume");
  });

  it("blocks a new deposit until the first move is final", async () => {
    const { world } = await refusedWhileConfirmed();
    const second = await deposit(world.env, { amount: AMOUNT, intent: { kind: "new" } });
    expect(second).toMatchObject({ status: "refused", reason: "unfinished-operation" });
    expect(world.solana.sent).toHaveLength(2);
    expect(world.events.filter((event) => event === "sign")).toHaveLength(1);
  });

  it("is closed without a click once the first move is final, and then a new deposit may start", async () => {
    const { world } = await refusedWhileConfirmed();
    await finishCompleted(world.env);
    expect(world.rows.size).toBe(1);
    finalize(world);
    await finishCompleted(world.env);
    expect(world.rows.size).toBe(0);
    world.stagedLanding(ATOMS);
    world.rollup.script({ fate: "land", effect: world.depositEffect(ATOMS) });
    expect(await deposit(world.env, { amount: "1", intent: { kind: "new" } })).toMatchObject({
      status: "done",
    });
  });

  it("credits the key's balance when the button is pressed, sending no second move", async () => {
    const { world } = await refusedWhileConfirmed();
    const record = world.record()!;
    world.rollup.script({ fate: "land", effect: world.depositEffect(ATOMS) });
    const outcome = await deposit(world.env, {
      amount: AMOUNT,
      intent: { kind: "resume", id: record.id, atoms: record.atoms },
    });
    expect(outcome).toMatchObject({ status: "done" });
    expect(world.solana.sent).toHaveLength(2);
    expect(world.rollup.token(world.keyAccount)).toBe(0n);
  });

  it("is refused again without losing the record when the program still says no", async () => {
    const { world } = await refusedWhileConfirmed();
    const record = world.record()!;
    world.rollup.script({ fate: "fail" });
    const again = await deposit(world.env, {
      amount: AMOUNT,
      intent: { kind: "resume", id: record.id, atoms: record.atoms },
    });
    expect(again).toMatchObject({ status: "stranded", recordKept: true });
    expect(world.record()?.stranded).toBe(true);
    expect(world.solana.sent).toHaveLength(2);
  });
});

describe("a deposit the program refused once its move into the rollup is final", () => {
  it("leaves no record, and the leftover button handles the key's balance", async () => {
    const world = makeWorld();
    world.stagedLanding(ATOMS);
    world.rollup.script({ fate: "fail" });
    const outcome = await deposit(world.env, { amount: AMOUNT, intent: { kind: "new" } });
    expect(outcome).toMatchObject({ status: "stranded", recordKept: false });
    expect(outcomeLine("deposit", outcome, 6, 1).text).toContain('"Put it in my account"');
    expect(world.rows.size).toBe(0);
    world.rollup.script({ fate: "land", effect: world.depositEffect(ATOMS) });
    expect(await recoverDepositKey(world.env)).toMatchObject({ status: "done" });
  });
});
