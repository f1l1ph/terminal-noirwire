import { describe, expect, it } from "vitest";
import { actionsOf, attentionOf } from "@/lib/transfer/attention";
import { deposit, recoverDepositKey } from "@/lib/transfer/deposit";
import { depositKeyLeftover } from "@/lib/transfer/leftover";
import { outcomeLine } from "@/lib/transfer/outcomeCopy";
import { resumeRecord } from "@/lib/transfer/resume";
import { returnToWallet } from "@/lib/transfer/returnToWallet";
import { withdraw } from "@/lib/transfer/withdraw";
import { legacyDeposit, makeWorld } from "./transferWorld";

const flows = { deposit, withdraw, returnToWallet };

const ATOMS = 2_500_000n;
const AMOUNT = "2.5";

const lineOf = (outcome: Awaited<ReturnType<typeof deposit>>) =>
  outcomeLine("deposit", outcome, 6, 35_000_000).text;

describe("a stranded key-based deposit has a way out in the records", () => {
  it("shows the record with Try the deposit again, and no return to the wallet", async () => {
    const world = makeWorld();
    world.solana.script({ fate: "land", effect: world.moveEffect(ATOMS) });
    world.rollup.script({ fate: "fail" });
    const outcome = await deposit(world.env, { amount: AMOUNT });
    expect(outcome).toMatchObject({ status: "stranded" });
    expect(lineOf(outcome)).toMatch(/Try the deposit again/);
    const [record] = [...world.rows.values()];
    const attention = attentionOf(record, null);
    expect(attention).toMatchObject({ keyed: true, resumable: true, returnable: false });
    expect(actionsOf(attention)).toContain("resume");
    expect(actionsOf(attention)).not.toContain("return");
  });

  it("credits the account when the button is pressed", async () => {
    const world = makeWorld();
    world.solana.script({ fate: "land", effect: world.moveEffect(ATOMS) });
    world.rollup.script({ fate: "fail" });
    await deposit(world.env, { amount: AMOUNT });
    const [record] = [...world.rows.values()];
    world.rollup.script({ fate: "land", effect: world.depositEffect(ATOMS) });
    const attention = attentionOf(record, null);
    const outcome = await resumeRecord(world.env, attention, 0n, flows, 6);
    expect(outcome).toMatchObject({ status: "done", atoms: ATOMS });
    expect(world.rollup.token(world.keyAccount)).toBe(0n);
    expect(world.solana.sent).toHaveLength(1);
  });

  it("keeps the button when the program refuses again, and says why, without sending by itself", async () => {
    const world = makeWorld();
    world.solana.script({ fate: "land", effect: world.moveEffect(ATOMS) });
    world.rollup.script({ fate: "fail" }, { fate: "fail" });
    await deposit(world.env, { amount: AMOUNT });
    const [record] = [...world.rows.values()];
    const attention = attentionOf(record, null);
    const again = await resumeRecord(world.env, attention, 0n, flows, 6);
    expect(again).toMatchObject({ status: "stranded" });
    expect(lineOf(again as Awaited<ReturnType<typeof deposit>>)).toMatch(/custody cap/);
    expect(world.rollup.sent).toHaveLength(2);
    const [kept] = [...world.rows.values()];
    expect(actionsOf(attentionOf(kept, null))).toContain("resume");
  });
});

describe("a balance left in the deposit key", () => {
  it("surfaces at load when a key that moved something holds USDC and nothing is open", async () => {
    const world = makeWorld();
    world.delegateKey(ATOMS);
    expect(await depositKeyLeftover(world.env)).toBe(ATOMS);
    expect(world.events).toEqual([]);
  });

  it("shows nothing for a key that never moved anything, without signing it in", async () => {
    const world = makeWorld();
    let signedIn = 0;
    world.env.depositRollup = async () => {
      signedIn += 1;
      return world.rollup;
    };
    expect(await depositKeyLeftover(world.env)).toBeNull();
    expect(signedIn).toBe(0);
  });

  it("shows nothing for an empty key or an unreadable rollup", async () => {
    const empty = makeWorld();
    empty.delegateKey(0n);
    expect(await depositKeyLeftover(empty.env)).toBeNull();
    const down = makeWorld();
    down.delegateKey(ATOMS);
    down.env.depositRollup = async () => {
      throw new Error("sign-in refused");
    };
    expect(await depositKeyLeftover(down.env)).toBeNull();
  });

  it("is credited by the one button, and gone after", async () => {
    const world = makeWorld();
    world.delegateKey(ATOMS);
    world.rollup.script({ fate: "land", effect: world.depositEffect(ATOMS) });
    const outcome = await recoverDepositKey(world.env);
    expect(outcome).toMatchObject({ status: "done", atoms: ATOMS });
    expect(await depositKeyLeftover(world.env)).toBeNull();
  });

  it("reports a refused recovery plainly, never retries by itself, and can be tried again", async () => {
    const world = makeWorld();
    world.delegateKey(ATOMS);
    world.rollup.script({ fate: "fail" });
    const refused = await recoverDepositKey(world.env);
    expect(refused).toMatchObject({ status: "stranded" });
    expect(lineOf(refused)).toMatch(/custody cap/);
    expect(world.rollup.sent).toHaveLength(1);
    expect(await depositKeyLeftover(world.env)).toBe(ATOMS);
    expect(world.rows.size).toBe(0);
    world.rollup.script({ fate: "land", effect: world.depositEffect(ATOMS) });
    const retried = await recoverDepositKey(world.env);
    expect(retried).toMatchObject({ status: "done", atoms: ATOMS });
    expect(world.rollup.sent).toHaveLength(2);
  });

  it("keeps a record begun by the earlier flow out of the key's button", async () => {
    const world = makeWorld();
    await legacyDeposit(world, "fail", ATOMS);
    const [record] = [...world.rows.values()];
    expect(attentionOf(record, null)).toMatchObject({ keyed: false, returnable: true });
  });
});
