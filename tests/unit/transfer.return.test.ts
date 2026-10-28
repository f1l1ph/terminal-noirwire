import { describe, expect, it } from "vitest";
import { actionsOf, attentionOf } from "@/lib/transfer/attention";
import { tryLockOwner } from "@/lib/transfer/lock";
import { giveBack } from "@/lib/transfer/resume";
import { returnToWallet } from "@/lib/transfer/returnToWallet";
import { USDC, legacyDeposit, makeWorld, type World } from "./transferWorld";

const ATOMS = 2_500_000n;
const START = 100n * USDC;

/** A deposit begun before deposits went through a deposit key, whose seat step was refused: the USDC sits in the owner's rollup balance. */
async function strandedDeposit(): Promise<World> {
  const world = makeWorld();
  await legacyDeposit(world, "fail", ATOMS);
  return world;
}

const recordsOf = (world: World) => [...world.rows.values()];

describe("a stranded deposit", () => {
  it("shows Return to wallet and a way to try the deposit again", async () => {
    const world = await strandedDeposit();
    const attention = attentionOf(recordsOf(world)[0], null);
    expect(actionsOf(attention)).toEqual(expect.arrayContaining(["resume", "return"]));
  });

  it("returns the tokens to the wallet once, journaled before the send", async () => {
    const world = await strandedDeposit();
    const attention = attentionOf(recordsOf(world)[0], null);
    world.solana.script({ fate: "land", effect: world.shuttleEffect(ATOMS) });
    const outcome = await giveBack(world.env, attention, { returnToWallet });
    expect(outcome).toMatchObject({ status: "done", atoms: ATOMS });
    expect(world.solana.token(world.wallet)).toBe(START);
    expect(world.solana.sent).toHaveLength(2);
    expect(world.events.indexOf("journal:record")).toBeLessThan(
      world.events.indexOf("broadcast:solana"),
    );
    expect(world.rows.size).toBe(0);
  });

  it("runs under the owner lock: another tab holding it gets nothing sent", async () => {
    const world = await strandedDeposit();
    const attention = attentionOf(recordsOf(world)[0], null);
    const held = await tryLockOwner(world.owner, world.locks);
    const outcome = await giveBack(world.env, attention, { returnToWallet });
    held?.release();
    expect(outcome).toEqual({ status: "busy" });
    expect(world.solana.sent).toHaveLength(1);
  });

  it("sends nothing for a record that is gone or is another one", async () => {
    const world = await strandedDeposit();
    const [record] = recordsOf(world);
    const gone = await returnToWallet(world.env, { intent: { id: "other", atoms: record.atoms } });
    expect(gone).toMatchObject({ status: "refused", reason: "record-changed" });
    const wrongAmount = await returnToWallet(world.env, { intent: { id: record.id, atoms: "1" } });
    expect(wrongAmount).toMatchObject({ status: "refused", reason: "record-changed" });
    expect(world.solana.sent).toHaveLength(1);
  });
});

describe("resuming a return", () => {
  it("is bound to the return record's own id and never repeats the send", async () => {
    const world = await strandedDeposit();
    const [deposited] = recordsOf(world);
    world.solana.swallowAll();
    const first = await returnToWallet(world.env, {
      intent: { id: deposited.id, atoms: deposited.atoms },
    });
    expect(first).toMatchObject({ status: "waiting" });
    const sent = world.solana.sent.length;
    const open = recordsOf(world).find((record) => record.step === "return");
    expect(open).toBeDefined();
    const attention = attentionOf(open!, null);
    expect(attention).toMatchObject({ operation: "return", resumable: true, returnable: false });
    expect(actionsOf(attention)).toContain("resume");
    const again = await returnToWallet(world.env, { intent: { id: open!.id, atoms: open!.atoms } });
    expect(again).toMatchObject({ status: "waiting" });
    expect(world.solana.sent).toHaveLength(sent);
    const stale = await returnToWallet(world.env, {
      intent: { id: deposited.id, atoms: deposited.atoms },
    });
    expect(stale).toMatchObject({ status: "refused", reason: "record-changed" });
    expect(world.solana.sent).toHaveLength(sent);
  });
});
