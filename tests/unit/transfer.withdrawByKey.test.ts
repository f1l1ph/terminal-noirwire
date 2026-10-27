import { describe, expect, it } from "vitest";
import { Transaction } from "@solana/web3.js";
import type { KeyWithdrawal } from "@/lib/trading/types";
import { attentionOf } from "@/lib/transfer/attention";
import { dismissRollupSend } from "@/lib/transfer/dismiss";
import {
  ORDER_KEY_CALL_SETTLES_WITHIN_MS,
  ORDER_KEY_WITHDRAWAL_UNPROVEN,
} from "@/lib/transfer/operation";
import { withdraw } from "@/lib/transfer/withdraw";
import { USDC, makeWorld, type World } from "./transferWorld";

const ATOMS = 2_500_000n;
const FREE = 5n * USDC;
const STALE_PRICE = 6038;

const ask = (world: World) => withdraw(world.env, { amount: "2.5", freeCollateral: FREE });

/** A world whose seat withdrawal is signed by an order key; `answers` are what the client says to each try, the last one repeating. */
function keyWorld(answers: KeyWithdrawal[], onWithdrawn?: () => void) {
  let calls = 0;
  const world: World = makeWorld({
    withdrawByKey: async () => {
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      if (answer.kind === "withdrawn") {
        world.seatEffect(ATOMS)();
        onWithdrawn?.();
      }
      return answer;
    },
  });
  world.delegate(0n);
  world.solana.script({ fate: "land", effect: world.shuttleEffect(ATOMS) });
  return { world, calls: () => calls };
}

describe("a withdrawal signed by an order key", () => {
  it("pays the seat out with no rollup transaction signed by the wallet, writing the send down first", async () => {
    const { world } = keyWorld([{ kind: "withdrawn" }]);
    const outcome = await ask(world);
    expect(outcome).toMatchObject({ status: "done", atoms: ATOMS });
    expect(world.solana.token(world.wallet)).toBe(100n * USDC + ATOMS);
    expect(world.rollup.sent).toEqual([]);
    expect(world.exchange.withdrawBuilds).toBe(0);
    expect(world.events).toEqual([
      "journal:record",
      "journal:seat",
      "key-withdraw",
      "sign",
      "journal:record",
      "broadcast:solana",
    ]);
    expect(world.rows.size).toBe(0);
  });

  it("refuses a wallet-signed rollup transaction, and still signs a Solana one", async () => {
    const { world } = keyWorld([{ kind: "withdrawn" }]);
    const tx = new Transaction({
      feePayer: world.keypair.publicKey,
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 1,
    });
    await expect(world.env.signChecked(tx, { kind: "setup" })).rejects.toThrow(
      /no wallet-signed rollup transaction/,
    );
    expect(world.signed).toEqual([]);
  });

  it("waits out a stale price and then withdraws, sending nothing in between", async () => {
    const { world, calls } = keyWorld([
      { kind: "refused", code: STALE_PRICE },
      { kind: "refused", code: STALE_PRICE },
      { kind: "withdrawn" },
    ]);
    const started = world.clock.now();
    expect(await ask(world)).toMatchObject({ status: "done" });
    expect(calls()).toBe(3);
    expect(world.clock.now() - started).toBeGreaterThanOrEqual(20_000);
  });

  it("gives up on a stale price after 240 seconds and leaves nothing on record but the operation", async () => {
    const { world } = keyWorld([{ kind: "refused", code: STALE_PRICE }]);
    const started = world.clock.now();
    const outcome = await ask(world);
    const waited = world.clock.now() - started;
    expect(outcome).toMatchObject({ status: "refused", reason: "stale-price" });
    expect(waited).toBeGreaterThanOrEqual(240_000);
    expect(waited).toBeLessThan(260_000);
    expect(world.record()?.seat).toBeUndefined();
    expect(world.solana.sent).toEqual([]);
  });

  it("reports another refusal as moving nothing and tries once", async () => {
    const { world, calls } = keyWorld([{ kind: "refused", code: 6001 }]);
    expect(await ask(world)).toMatchObject({ status: "refused", reason: "rollup-refused" });
    expect(calls()).toBe(1);
    expect(world.record()?.seat).toBeUndefined();
    expect(world.solana.sent).toEqual([]);
  });

  it("explains an exchange with too many markets for one withdrawal", async () => {
    const { world } = keyWorld([{ kind: "tooLarge" }]);
    const outcome = await ask(world);
    expect(outcome).toMatchObject({ status: "refused", reason: "rollup-refused" });
    expect(outcome).toMatchObject({ message: expect.stringContaining("more markets") });
    expect(world.record()?.seat).toBeUndefined();
  });

  it("says a withdrawal that can no longer run moved nothing", async () => {
    const { world } = keyWorld([{ kind: "didNotRun" }]);
    expect(await ask(world)).toMatchObject({ status: "refused", reason: "rollup-refused" });
    expect(world.record()?.seat).toBeUndefined();
  });

  it("never calls an undetermined withdrawal done or undone, keeps it on record and never sends it again", async () => {
    const { world, calls } = keyWorld([{ kind: "undetermined" }]);
    const outcome = await ask(world);
    expect(outcome).toMatchObject({ status: "waiting", message: ORDER_KEY_WITHDRAWAL_UNPROVEN });
    expect(ORDER_KEY_WITHDRAWAL_UNPROVEN).toContain("token account");
    expect(ORDER_KEY_WITHDRAWAL_UNPROVEN).not.toMatch(/withdrawn|nothing happened/i);
    expect(world.record()?.seat).toMatchObject({ state: "pending", signer: "order-key" });
    const again = await ask(world);
    expect(again).toMatchObject({ status: "waiting", message: ORDER_KEY_WITHDRAWAL_UNPROVEN });
    expect(calls()).toBe(1);
    expect(world.solana.sent).toEqual([]);
  });

  it("settles an undetermined withdrawal from the owner's token account once the call can no longer run", async () => {
    const { world, calls } = keyWorld([{ kind: "undetermined" }]);
    await ask(world);
    const record = world.record()!;
    expect(attentionOf(record, "pending", [record])).toMatchObject({
      kind: "waiting",
      resumable: false,
    });
    world.clock.t += 6 * 60_000;
    const again = await ask(world);
    expect(again).toMatchObject({ status: "not-landed", id: record.id });
    expect(attentionOf(record, "not-seen", [record])).toMatchObject({ kind: "not-landed" });
    expect(await dismissRollupSend(world.env)).toMatchObject({ status: "dismissed" });
    expect(world.rows.size).toBe(0);
    expect(calls()).toBe(1);
    expect(world.solana.sent).toEqual([]);
  });

  it("takes an undetermined withdrawal as done when the owner's token account rose by it", async () => {
    const { world, calls } = keyWorld([{ kind: "undetermined" }]);
    await ask(world);
    world.seatEffect(ATOMS)();
    expect(await ask(world)).toMatchObject({ status: "done" });
    expect(calls()).toBe(1);
    expect(world.solana.token(world.wallet)).toBe(100n * USDC + ATOMS);
    expect(world.rows.size).toBe(0);
  });

  it("clears the pending record and refuses when the client threw and nothing ran", async () => {
    const world = makeWorld({
      withdrawByKey: async () => {
        throw new Error("failed to fetch");
      },
    });
    world.delegate(0n);
    const outcome = await ask(world);
    expect(outcome).toMatchObject({ status: "refused", reason: "send-failed" });
    expect(world.rows.size).toBe(0);
    expect(world.solana.sent).toEqual([]);
    const next = await withdraw(world.env, {
      amount: "2.5",
      freeCollateral: FREE,
      intent: { kind: "new" },
    });
    expect(next).toMatchObject({ status: "refused", reason: "send-failed" });
  });

  it("waits out the call before judging a throw, so a call that was sent cannot land afterwards", async () => {
    const world = makeWorld({
      withdrawByKey: async () => {
        throw new Error("socket closed");
      },
    });
    world.delegate(0n);
    const started = world.clock.now();
    await ask(world);
    expect(world.clock.now() - started).toBeGreaterThanOrEqual(ORDER_KEY_CALL_SETTLES_WITHIN_MS);
  });

  it("goes on to the Solana step when the client threw after the withdrawal ran", async () => {
    const world = makeWorld({
      withdrawByKey: async () => {
        world.seatEffect(ATOMS)();
        throw new Error("socket closed");
      },
    });
    world.delegate(0n);
    world.solana.script({ fate: "land", effect: world.shuttleEffect(ATOMS) });
    expect(await ask(world)).toMatchObject({ status: "done" });
    expect(world.rows.size).toBe(0);
  });

  it("keeps the record and sends nothing again when the client threw and the balance cannot be read", async () => {
    const world = makeWorld({
      withdrawByKey: async () => {
        throw new Error("socket closed");
      },
    });
    world.delegate(0n);
    const read = world.rollup.getAccountInfo.bind(world.rollup);
    let reads = 0;
    world.rollup.getAccountInfo = async (address) => {
      reads += 1;
      if (reads > 2) throw new Error("429 Too Many Requests");
      return read(address);
    };
    expect(await ask(world)).toMatchObject({ status: "waiting" });
    expect(world.record()?.seat).toMatchObject({ state: "pending", signer: "order-key" });
    expect(world.solana.sent).toEqual([]);
    const record = world.record()!;
    expect(attentionOf(record, "unreadable", [record])).toMatchObject({
      kind: "waiting",
      resumable: true,
    });
  });

  it("carries on to the Solana step when the record shows the key withdrawal landed", async () => {
    const world = makeWorld({ withdrawByKey: async () => ({ kind: "withdrawn" }) });
    world.delegate(0n);
    await world.env.journal.record(world.owner, {
      id: "old",
      kind: "withdraw",
      atoms: ATOMS.toString(),
      step: "withdraw",
      sends: [],
    });
    await world.env.journal.recordSeatSend(world.owner, "old", {
      state: "pending",
      at: "t",
      id: "s1",
      before: "0",
      signer: "order-key",
    });
    await world.env.journal.markSeatLanded(world.owner, "old");
    world.seatEffect(ATOMS)();
    world.solana.script({ fate: "land", effect: world.shuttleEffect(ATOMS) });
    world.events.length = 0;
    expect(await ask(world)).toMatchObject({ status: "done", id: "old" });
    expect(world.events).not.toContain("key-withdraw");
    expect(world.rows.size).toBe(0);
  });
});
