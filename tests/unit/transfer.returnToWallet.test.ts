import { describe, expect, it } from "vitest";
import { deposit } from "@/lib/transfer/deposit";
import { dismissRollupSend } from "@/lib/transfer/dismiss";
import { returnToWallet } from "@/lib/transfer/returnToWallet";
import { USDC, makeWorld, type World } from "./transferWorld";

const ATOMS = 2_500_000n;
const AMOUNT = "2.5";
const START = 100n * USDC;

/** A deposit whose move into the rollup landed and whose collateral step then did the given thing. */
async function depositThatStopped(fate: "fail" | "swallow"): Promise<World> {
  const world = makeWorld();
  world.solana.script({ fate: "land", effect: world.moveEffect(ATOMS) });
  world.rollup.script({ fate });
  await deposit(world.env, { amount: AMOUNT });
  world.events.length = 0;
  return world;
}

describe("returnToWallet", () => {
  it("takes the rollup balance back to the wallet when the deposit was refused", async () => {
    const world = await depositThatStopped("fail");
    expect(world.solana.token(world.wallet)).toBe(START - ATOMS);
    world.solana.script({ fate: "land", effect: world.shuttleEffect(ATOMS) });
    const outcome = await returnToWallet(world.env);
    expect(outcome).toMatchObject({ status: "done", atoms: ATOMS });
    expect(world.solana.token(world.wallet)).toBe(START);
    expect(world.rollup.token(world.wallet)).toBe(0n);
    expect(world.rows.size).toBe(0);
    expect(world.rollup.sent).toHaveLength(1);
  });

  it("writes the return down before it is broadcast", async () => {
    const world = await depositThatStopped("fail");
    world.solana.script({ fate: "land", effect: world.shuttleEffect(ATOMS) });
    await returnToWallet(world.env);
    expect(world.events).toEqual(["sign", "journal:record", "broadcast:solana"]);
  });

  it("does not send a second return while the first may still land", async () => {
    const world = await depositThatStopped("fail");
    world.solana.script({ fate: "swallow" });
    const first = await returnToWallet(world.env);
    expect(first).toMatchObject({ status: "waiting" });
    const sent = world.solana.sent.length;
    expect(await returnToWallet(world.env)).toMatchObject({ status: "waiting" });
    expect(world.solana.sent).toHaveLength(sent);
  });

  it("does not let a new deposit start while a return is unfinished", async () => {
    const world = await depositThatStopped("fail");
    world.solana.script({ fate: "swallow" });
    await returnToWallet(world.env);
    const outcome = await deposit(world.env, { amount: AMOUNT });
    expect(outcome).toMatchObject({ status: "refused", reason: "unfinished-operation" });
    expect(new Set(world.solana.sent).size).toBe(2);
  });

  it("sends nothing while the collateral step may still land, whatever the user answers", async () => {
    const world = await depositThatStopped("swallow");
    const seat = world.record()?.seat;
    for (const answer of [undefined, `lost:${seat?.id}`]) {
      const outcome = await returnToWallet(world.env, { answer });
      expect(outcome).toMatchObject({ status: "waiting" });
    }
    expect(world.solana.sent).toHaveLength(1);
    expect(world.events).toEqual([]);
  });

  it("refuses to return what the collateral step already moved into the seat", async () => {
    const world = await depositThatStopped("swallow");
    world.rollup.statuses.set(world.rollup.sent[0], { err: null, confirmationStatus: "confirmed" });
    const outcome = await returnToWallet(world.env);
    expect(outcome).toMatchObject({ status: "refused", reason: "deposit-landed" });
    expect(world.solana.sent).toHaveLength(1);
  });

  it("returns only after the collateral step that did not go through is dismissed by hand", async () => {
    const world = await depositThatStopped("swallow");
    world.rollup.height += 200;
    expect(await returnToWallet(world.env)).toMatchObject({ status: "not-landed" });
    expect(world.solana.sent).toHaveLength(1);
    expect(await dismissRollupSend(world.env)).toMatchObject({ status: "dismissed" });
    world.solana.script({ fate: "land", effect: world.shuttleEffect(ATOMS) });
    const outcome = await returnToWallet(world.env);
    expect(outcome).toMatchObject({ status: "done", atoms: ATOMS });
    expect(world.solana.token(world.wallet)).toBe(START);
  });

  it("has nothing to return without an unfinished deposit", async () => {
    const world = makeWorld();
    const outcome = await returnToWallet(world.env);
    expect(outcome).toMatchObject({ status: "refused", reason: "nothing-to-return" });
    expect(world.events).toEqual([]);
  });

  it("is blocked while another tab holds the owner's lock", async () => {
    const world = await depositThatStopped("fail");
    const { tryLockOwner } = await import("@/lib/transfer/lock");
    const held = await tryLockOwner(world.owner, world.locks);
    expect(await returnToWallet(world.env)).toEqual({ status: "busy" });
    expect(world.events).toEqual([]);
    held?.release();
  });
});
