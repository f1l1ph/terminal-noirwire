import { describe, expect, it } from "vitest";
import { Transaction } from "@solana/web3.js";
import type { KeyWithdrawal } from "@/lib/trading/types";
import { actionsOf, attentionOf } from "@/lib/transfer/attention";
import { dismissRollupSend } from "@/lib/transfer/dismiss";
import { NotDispatched } from "@/lib/transfer/keyedWithdrawal";
import { ORDER_KEY_WITHDRAWAL_UNPROVEN } from "@/lib/transfer/operation";
import { signatureOf } from "@/lib/transfer/send";
import { withdraw } from "@/lib/transfer/withdraw";
import { USDC, makeWorld, type World } from "./transferWorld";

const ATOMS = 2_500_000n;
const FREE = 5n * USDC;
const STALE_PRICE = 6038;

const ask = (world: World) => withdraw(world.env, { amount: "2.5", freeCollateral: FREE });

/** Signed bytes as far as the journal can tell: a count, a signature, nothing else. */
const signedBytes = (call: number) => {
  const raw = new Uint8Array(65);
  raw[0] = 1;
  raw.fill(call + 1, 1);
  return raw;
};

/** What the client does on one try: answers, or throws after having handed over its signed bytes (or before). */
type Try = KeyWithdrawal | { throws: Error; signedFirst: boolean };

/** A world whose seat withdrawal is signed by an order key; `answers` are what the client says to each try, the last one repeating. */
function keyWorld(answers: Try[], onWithdrawn?: () => void) {
  let calls = 0;
  const world: World = makeWorld({
    withdrawByKey: async (_atoms, onSigned) => {
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      if (!("throws" in answer) || answer.signedFirst) await onSigned?.(signedBytes(calls));
      if ("throws" in answer) throw answer.throws;
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

  it("writes the signature and expiry of the signed bytes down before they are dispatched", async () => {
    const { world } = keyWorld([{ kind: "undetermined" }]);
    await ask(world);
    expect(world.record()?.seat).toMatchObject({
      state: "pending",
      signer: "order-key",
      signature: signatureOf(signedBytes(1)),
      lastValidBlockHeight: world.rollup.height + 150,
    });
  });
});

describe("an order key withdrawal whose outcome the client could not prove", () => {
  const undetermined = () => keyWorld([{ kind: "undetermined" }]);

  it("is never called done or undone by what it asked, kept on record and never sent again", async () => {
    const { world, calls } = undetermined();
    const outcome = await ask(world);
    expect(outcome).toMatchObject({ status: "waiting", message: ORDER_KEY_WITHDRAWAL_UNPROVEN });
    expect(ORDER_KEY_WITHDRAWAL_UNPROVEN).toContain("token account");
    expect(ORDER_KEY_WITHDRAWAL_UNPROVEN).not.toMatch(/withdrawn|nothing happened/i);
    const again = await ask(world);
    expect(again).toMatchObject({ status: "waiting" });
    expect(again.status === "waiting" && again.message).toContain(signatureOf(signedBytes(1)));
    expect(calls()).toBe(1);
    expect(world.solana.sent).toEqual([]);
  });

  it("is settled by its signature's status like any rollup send: landed at finalized goes on", async () => {
    const { world, calls } = undetermined();
    await ask(world);
    const signature = signatureOf(signedBytes(1));
    world.rollup.statuses.set(signature, { err: null, confirmationStatus: "finalized" });
    expect(await ask(world)).toMatchObject({ status: "done" });
    expect(calls()).toBe(1);
    expect(world.rows.size).toBe(0);
  });

  it("is cleared when its status shows a finalized error", async () => {
    const { world } = undetermined();
    await ask(world);
    world.rollup.statuses.set(signatureOf(signedBytes(1)), {
      err: { InstructionError: [0, { Custom: 6001 }] },
      confirmationStatus: "finalized",
    });
    expect(await ask(world)).toMatchObject({ status: "refused", reason: "rollup-refused" });
    expect(world.rows.size).toBe(0);
  });

  it("can be dismissed, and then only, once its blockhash has expired with the status still absent", async () => {
    const { world, calls } = undetermined();
    await ask(world);
    const record = world.record()!;
    expect(attentionOf(record, "pending", [record])).toMatchObject({
      kind: "waiting",
      resumable: false,
    });
    expect(await dismissRollupSend(world.env)).toMatchObject({ reason: "not-dismissable" });
    world.clock.t += 60 * 60_000;
    expect(await ask(world)).toMatchObject({ status: "waiting" });
    world.rollup.height += 200;
    expect(await ask(world)).toMatchObject({ status: "not-landed", id: record.id });
    expect(actionsOf(attentionOf(record, "not-seen", [record]))).toContain("dismiss");
    expect(await dismissRollupSend(world.env)).toMatchObject({ status: "dismissed" });
    expect(world.rows.size).toBe(0);
    expect(calls()).toBe(1);
    expect(world.solana.sent).toEqual([]);
  });

  it("is not taken as landed by an unrelated credit to the owner's token account", async () => {
    const { world } = undetermined();
    await ask(world);
    world.seatEffect(ATOMS)();
    expect(await ask(world)).toMatchObject({ status: "waiting" });
    expect(world.record()?.seat?.state).toBe("pending");
    expect(world.solana.sent).toEqual([]);
  });
});

describe("an order key withdrawal whose client threw", () => {
  const boom = new Error("socket closed");

  it("clears the pending record and refuses when it was stopped before anything was sent", async () => {
    const { world } = keyWorld([{ throws: new NotDispatched(boom), signedFirst: false }]);
    const outcome = await ask(world);
    expect(outcome).toMatchObject({ status: "refused", reason: "send-failed" });
    expect(world.rows.size).toBe(0);
    expect(world.solana.sent).toEqual([]);
  });

  it("keeps the record, with its signature, when the bytes had been handed over", async () => {
    const { world, calls } = keyWorld([{ throws: boom, signedFirst: true }]);
    expect(await ask(world)).toMatchObject({ status: "waiting" });
    expect(world.record()?.seat).toMatchObject({
      state: "pending",
      signer: "order-key",
      signature: signatureOf(signedBytes(1)),
    });
    expect(world.solana.sent).toEqual([]);
    expect(calls()).toBe(1);
  });

  it("never clears it on elapsed time or a balance that has not risen", async () => {
    const { world } = keyWorld([{ throws: boom, signedFirst: true }]);
    await ask(world);
    world.clock.t += 24 * 60 * 60_000;
    expect(await ask(world)).toMatchObject({ status: "waiting" });
    expect(world.record()?.seat?.state).toBe("pending");
  });

  it("goes on to the Solana step once the status shows the withdrawal ran", async () => {
    const { world } = keyWorld([{ throws: boom, signedFirst: true }]);
    await ask(world);
    world.seatEffect(ATOMS)();
    world.rollup.statuses.set(signatureOf(signedBytes(1)), {
      err: null,
      confirmationStatus: "finalized",
    });
    expect(await ask(world)).toMatchObject({ status: "done" });
    expect(world.rows.size).toBe(0);
  });

  it("stays on record without a signature when nothing could be told about the call, and sends nothing", async () => {
    const { world } = keyWorld([{ throws: boom, signedFirst: false }]);
    expect(await ask(world)).toMatchObject({ status: "waiting" });
    expect(world.record()?.seat).toMatchObject({ state: "pending", signer: "order-key" });
    expect(world.record()?.seat?.signature).toBeUndefined();
    expect(await ask(world)).toMatchObject({ status: "unknown", subject: "rollup-send" });
    expect(world.solana.sent).toEqual([]);
  });
});

describe("a withdrawal recorded as landed by an order key", () => {
  it("carries on to the Solana step", async () => {
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
