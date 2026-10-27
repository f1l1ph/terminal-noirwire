import { describe, expect, it } from "vitest";
import { Transaction } from "@solana/web3.js";
import type { KeyWithdrawal } from "@/lib/trading/types";
import { actionsOf, attentionOf } from "@/lib/transfer/attention";
import { dismissRollupSend } from "@/lib/transfer/dismiss";
import { blockhashOf, NotDispatched } from "@/lib/transfer/keyedWithdrawal";
import { ORDER_KEY_WITHDRAWAL_UNPROVEN } from "@/lib/transfer/operation";
import { signatureOf } from "@/lib/transfer/send";
import { withdraw } from "@/lib/transfer/withdraw";
import { USDC, makeWorld, signedAttempt, type World } from "./transferWorld";

const ATOMS = 2_500_000n;
const FREE = 5n * USDC;
const STALE_PRICE = 6038;

const ask = (world: World) => withdraw(world.env, { amount: "2.5", freeCollateral: FREE });

/** What the client does on one try: answers, or throws; `signs` are the attempts it hands over before dispatching (the call's own number by default; none for a client that never hands any over). */
type Try = (KeyWithdrawal | { throws: Error }) & { signs?: number[] };

/** A world whose seat withdrawal is signed by an order key; `answers` are what the client says to each try, the last one repeating. */
function keyWorld(answers: Try[], onWithdrawn?: () => void) {
  let calls = 0;
  const world: World = makeWorld({
    withdrawByKey: async (_atoms, onSigned) => {
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      for (const attempt of answer.signs ?? [calls]) await onSigned?.(signedAttempt(attempt));
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

const signatureOfAttempt = (call: number) => signatureOf(signedAttempt(call));
const status = (world: World, call: number, confirmationStatus: string, err: unknown = null) =>
  world.rollup.statuses.set(signatureOfAttempt(call), { err, confirmationStatus });

const REFUSED = { InstructionError: [0, { Custom: 6001 }] };

/** The first `count` attempts the fake client signs are refused by the program, as the rollup shows them at finalized. */
const refusedAtFinality = (world: World, count: number) => {
  for (let call = 1; call <= count; call += 1) status(world, call, "finalized", REFUSED);
};

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
    refusedAtFinality(world, 3);
    const started = world.clock.now();
    expect(await ask(world)).toMatchObject({ status: "done" });
    expect(calls()).toBe(3);
    expect(world.clock.now() - started).toBeGreaterThanOrEqual(20_000);
  });

  it("gives up on a stale price after 240 seconds and leaves nothing on record but the operation", async () => {
    const { world } = keyWorld([{ kind: "refused", code: STALE_PRICE }]);
    refusedAtFinality(world, 60);
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
    refusedAtFinality(world, 1);
    expect(await ask(world)).toMatchObject({ status: "refused", reason: "rollup-refused" });
    expect(calls()).toBe(1);
    expect(world.record()?.seat).toBeUndefined();
    expect(world.solana.sent).toEqual([]);
  });

  it("explains an exchange with too many markets for one withdrawal", async () => {
    const { world } = keyWorld([{ kind: "tooLarge", signs: [] }]);
    const outcome = await ask(world);
    expect(outcome).toMatchObject({ status: "refused", reason: "rollup-refused" });
    expect(outcome).toMatchObject({ message: expect.stringContaining("more markets") });
    expect(world.record()?.seat).toBeUndefined();
  });

  it("says a withdrawal that can no longer run moved nothing", async () => {
    const { world } = keyWorld([{ kind: "didNotRun" }]);
    world.rollup.expireAllBlockhashes();
    expect(await ask(world)).toMatchObject({ status: "refused", reason: "rollup-refused" });
    expect(world.record()?.seat).toBeUndefined();
  });

  it("writes the signature and the exact blockhash of the signed bytes down before they are dispatched", async () => {
    const { world } = keyWorld([{ kind: "undetermined" }]);
    await ask(world);
    expect(world.record()?.seat).toMatchObject({
      state: "pending",
      signer: "order-key",
      signature: signatureOfAttempt(1),
      attempts: [{ signature: signatureOfAttempt(1), blockhash: blockhashOf(signedAttempt(1)) }],
    });
  });
});

describe("an order key withdrawal whose outcome the client could not prove", () => {
  const undetermined = (signs?: number[]) => keyWorld([{ kind: "undetermined", signs }]);

  it("is never called done or undone by what it asked, kept on record and never sent again", async () => {
    const { world, calls } = undetermined();
    const outcome = await ask(world);
    expect(outcome).toMatchObject({ status: "waiting", message: ORDER_KEY_WITHDRAWAL_UNPROVEN });
    expect(ORDER_KEY_WITHDRAWAL_UNPROVEN).toContain("token account");
    expect(ORDER_KEY_WITHDRAWAL_UNPROVEN).not.toMatch(/withdrawn|nothing happened/i);
    const again = await ask(world);
    expect(again).toMatchObject({ status: "waiting" });
    expect(again.status === "waiting" && again.message).toContain(signatureOfAttempt(1));
    expect(calls()).toBe(1);
    expect(world.solana.sent).toEqual([]);
  });

  it("is settled by its signature's status like any rollup send: landed at finalized goes on", async () => {
    const { world, calls } = undetermined();
    await ask(world);
    status(world, 1, "finalized");
    expect(await ask(world)).toMatchObject({ status: "done" });
    expect(calls()).toBe(1);
    expect(world.rows.size).toBe(0);
  });

  it("is cleared when its status shows a finalized error", async () => {
    const { world } = undetermined();
    await ask(world);
    status(world, 1, "finalized", { InstructionError: [0, { Custom: 6001 }] });
    expect(await ask(world)).toMatchObject({ status: "refused", reason: "rollup-refused" });
    expect(world.rows.size).toBe(0);
  });

  it("is not taken as landed by an unrelated credit to the owner's token account", async () => {
    const { world } = undetermined();
    await ask(world);
    world.seatEffect(ATOMS)();
    expect(await ask(world)).toMatchObject({ status: "waiting" });
    expect(world.record()?.seat?.state).toBe("pending");
    expect(world.solana.sent).toEqual([]);
  });

  it("is judged by the blockhash it was signed with, not by the rollup's latest one or its height", async () => {
    const { world } = undetermined();
    await ask(world);
    world.rollup.height += 100_000;
    world.rollup.expiredBlockhashes.add(blockhashOf(signedAttempt(2)));
    expect(await ask(world)).toMatchObject({ status: "waiting" });
    world.rollup.expiredBlockhashes.add(blockhashOf(signedAttempt(1)));
    expect(await ask(world)).toMatchObject({ status: "not-landed" });
  });

  it("can be dismissed only when never seen, expired, and absent on two reads apart", async () => {
    const { world, calls } = undetermined();
    await ask(world);
    const record = world.record()!;
    expect(attentionOf(record, "pending", [record])).toMatchObject({
      kind: "waiting",
      resumable: false,
    });
    expect(await dismissRollupSend(world.env)).toMatchObject({ reason: "not-dismissable" });
    world.rollup.expireAllBlockhashes();
    const started = world.clock.now();
    expect(await ask(world)).toMatchObject({ status: "not-landed", id: record.id });
    expect(world.clock.now() - started).toBeGreaterThanOrEqual(3_000);
    expect(actionsOf(attentionOf(record, "not-seen", [record]))).toContain("dismiss");
    expect(await dismissRollupSend(world.env)).toMatchObject({ status: "dismissed" });
    expect(world.rows.size).toBe(0);
    expect(calls()).toBe(1);
    expect(world.solana.sent).toEqual([]);
  });

  it("is not dismissed when the second read finds it", async () => {
    const { world } = undetermined();
    await ask(world);
    world.rollup.expireAllBlockhashes();
    const read = world.rollup.getSignatureStatus.bind(world.rollup);
    let reads = 0;
    world.rollup.getSignatureStatus = async (signature: string) => {
      reads += 1;
      if (reads === 2) status(world, 1, "finalized");
      return read(signature);
    };
    expect(await dismissRollupSend(world.env)).toMatchObject({ reason: "not-dismissable" });
    expect(world.record()?.seat?.state).toBe("pending");
  });

  it("remembers a sighting, and a status missing after it is never unable to land", async () => {
    const { world } = undetermined();
    await ask(world);
    status(world, 1, "processed");
    expect(await ask(world)).toMatchObject({ status: "waiting" });
    expect(world.record()?.seat?.attempts?.[0]).toMatchObject({ seen: true });
    world.rollup.statuses.delete(signatureOfAttempt(1));
    world.rollup.expireAllBlockhashes();
    world.rollup.height += 100_000;
    const outcome = await ask(world);
    expect(outcome).toMatchObject({ status: "waiting" });
    expect(outcome.status === "waiting" && outcome.message).toContain("was seen");
    expect(await dismissRollupSend(world.env)).toMatchObject({ reason: "not-dismissable" });
    const record = world.record()!;
    expect(attentionOf(record, "vanished", [record])).toMatchObject({
      kind: "waiting",
      resumable: true,
    });
    expect(actionsOf(attentionOf(record, "vanished", [record]))).not.toContain("dismiss");
    status(world, 1, "finalized");
    expect(await ask(world)).toMatchObject({ status: "done" });
  });

  it("still clears on a finalized refusal after a sighting", async () => {
    const { world } = undetermined();
    await ask(world);
    status(world, 1, "processed");
    await ask(world);
    status(world, 1, "finalized", { InstructionError: [0, { Custom: 6001 }] });
    expect(await ask(world)).toMatchObject({ status: "refused", reason: "rollup-refused" });
    expect(world.rows.size).toBe(0);
  });
});

describe("an order key withdrawal the client signed more than once", () => {
  const resigned = () => keyWorld([{ kind: "undetermined", signs: [1, 2] }]);

  it("keeps every distinct attempt, and the same signature again changes nothing", async () => {
    const { world } = keyWorld([{ kind: "undetermined", signs: [1, 2, 2, 1] }]);
    await ask(world);
    const seat = world.record()!.seat!;
    expect(seat.attempts?.map((attempt) => attempt.signature)).toEqual([
      signatureOfAttempt(1),
      signatureOfAttempt(2),
    ]);
    expect(seat.signature).toBe(signatureOfAttempt(2));
  });

  it("goes on if the first attempt ran, however the second fared", async () => {
    const { world } = resigned();
    await ask(world);
    status(world, 1, "finalized");
    status(world, 2, "finalized", { InstructionError: [0, { Custom: 6001 }] });
    expect(await ask(world)).toMatchObject({ status: "done" });
  });

  it("is not cleared by the second attempt's refusal while the first may still run", async () => {
    const { world } = resigned();
    await ask(world);
    status(world, 2, "finalized", { InstructionError: [0, { Custom: 6001 }] });
    expect(await ask(world)).toMatchObject({ status: "waiting" });
    expect(world.record()?.seat?.state).toBe("pending");
    expect(world.solana.sent).toEqual([]);
  });

  it("is cleared only when every attempt is refused", async () => {
    const { world } = resigned();
    await ask(world);
    status(world, 2, "finalized", { InstructionError: [0, { Custom: 6001 }] });
    status(world, 1, "finalized", { InstructionError: [0, { Custom: 6001 }] });
    expect(await ask(world)).toMatchObject({ status: "refused", reason: "rollup-refused" });
    expect(world.rows.size).toBe(0);
  });

  it("can be dismissed only when every attempt is expired and unseen, one refused and one absent counting", async () => {
    const { world } = resigned();
    await ask(world);
    status(world, 2, "finalized", { InstructionError: [0, { Custom: 6001 }] });
    expect(await dismissRollupSend(world.env)).toMatchObject({ reason: "not-dismissable" });
    world.rollup.expiredBlockhashes.add(blockhashOf(signedAttempt(1)));
    expect(await dismissRollupSend(world.env)).toMatchObject({ status: "dismissed" });
  });

  it("is not dismissed while one attempt was seen and has gone missing", async () => {
    const { world } = resigned();
    await ask(world);
    status(world, 1, "processed");
    await ask(world);
    world.rollup.statuses.delete(signatureOfAttempt(1));
    world.rollup.expireAllBlockhashes();
    expect(await dismissRollupSend(world.env)).toMatchObject({ reason: "not-dismissable" });
  });
});

describe("an order key withdrawal whose client threw", () => {
  const boom = new Error("socket closed");

  it("clears the pending record and refuses when it was stopped before anything was sent", async () => {
    const { world } = keyWorld([{ throws: new NotDispatched(boom), signs: [] }]);
    const outcome = await ask(world);
    expect(outcome).toMatchObject({ status: "refused", reason: "send-failed" });
    expect(world.rows.size).toBe(0);
    expect(world.solana.sent).toEqual([]);
  });

  it("keeps the record, with its attempt, when the bytes had been handed over", async () => {
    const { world, calls } = keyWorld([{ throws: boom }]);
    expect(await ask(world)).toMatchObject({ status: "waiting" });
    expect(world.record()?.seat).toMatchObject({
      state: "pending",
      signer: "order-key",
      signature: signatureOfAttempt(1),
    });
    expect(world.solana.sent).toEqual([]);
    expect(calls()).toBe(1);
  });

  it("never clears it on elapsed time or a balance that has not risen", async () => {
    const { world } = keyWorld([{ throws: boom }]);
    await ask(world);
    world.clock.t += 24 * 60 * 60_000;
    expect(await ask(world)).toMatchObject({ status: "waiting" });
    expect(world.record()?.seat?.state).toBe("pending");
  });

  it("goes on to the Solana step once the status shows the withdrawal ran", async () => {
    const { world } = keyWorld([{ throws: boom }]);
    await ask(world);
    world.seatEffect(ATOMS)();
    status(world, 1, "finalized");
    expect(await ask(world)).toMatchObject({ status: "done" });
    expect(world.rows.size).toBe(0);
  });

  it("stays on record without an attempt when the client never handed any over, and has a way forward", async () => {
    const { world } = keyWorld([{ throws: boom, signs: [] }]);
    expect(await ask(world)).toMatchObject({ status: "waiting" });
    expect(world.record()?.seat).toMatchObject({ state: "pending", signer: "order-key" });
    expect(world.record()?.seat?.attempts).toBeUndefined();
    const again = await ask(world);
    expect(again).toMatchObject({ status: "unknown", subject: "rollup-send" });
    expect(again.status === "unknown" && again.message).toContain("transfer id");
    const record = world.record()!;
    const attention = attentionOf(record, "unknown", [record]);
    expect(attention).toMatchObject({ kind: "unknown", resumable: true });
    expect(actionsOf(attention)).toContain("resume");
    expect(world.solana.sent).toEqual([]);
  });
});

describe("the client's answer about the last attempt, when an earlier one was dispatched too", () => {
  it("does not clear the record or send again on a refusal of the second attempt while the first is unresolved", async () => {
    const { world, calls } = keyWorld([{ kind: "refused", code: 6001, signs: [1, 2] }]);
    status(world, 2, "finalized", REFUSED);
    const outcome = await ask(world);
    expect(outcome).toMatchObject({ status: "waiting" });
    expect(world.record()?.seat?.state).toBe("pending");
    expect(world.record()?.seat?.attempts).toHaveLength(2);
    expect(calls()).toBe(1);
    expect(world.solana.sent).toEqual([]);
  });

  it("does not retry a stale price on the second attempt's refusal while the first is unresolved", async () => {
    const { world, calls } = keyWorld([
      { kind: "refused", code: STALE_PRICE, signs: [1, 2] },
      { kind: "withdrawn" },
    ]);
    status(world, 2, "finalized", REFUSED);
    expect(await ask(world)).toMatchObject({ status: "waiting" });
    expect(calls()).toBe(1);
    expect(world.record()?.seat?.state).toBe("pending");
  });

  it("goes on when the first attempt turns out to have run", async () => {
    const { world, calls } = keyWorld([{ kind: "refused", code: 6001, signs: [1, 2] }]);
    status(world, 1, "finalized");
    status(world, 2, "finalized", REFUSED);
    expect(await ask(world)).toMatchObject({ status: "done" });
    expect(calls()).toBe(1);
  });

  it("clears and retries only once every attempt is refused at finalized", async () => {
    const { world, calls } = keyWorld([
      { kind: "refused", code: STALE_PRICE, signs: [1, 2] },
      { kind: "withdrawn", signs: [3] },
    ]);
    refusedAtFinality(world, 2);
    expect(await ask(world)).toMatchObject({ status: "done" });
    expect(calls()).toBe(2);
  });

  it("waits for the refusal to be final before acting on it", async () => {
    const { world } = keyWorld([{ kind: "refused", code: 6001 }]);
    const started = world.clock.now();
    expect(await ask(world)).toMatchObject({ status: "waiting" });
    expect(world.clock.now() - started).toBeGreaterThanOrEqual(60_000);
    expect(world.record()?.seat?.state).toBe("pending");
  });
});

describe("an order key withdrawal that a status showed landed, as against one the client proved", () => {
  const confirmed = async () => {
    const { world } = keyWorld([{ kind: "undetermined" }]);
    await ask(world);
    status(world, 1, "confirmed");
    expect(await ask(world)).toMatchObject({ status: "waiting" });
    return world;
  };

  it("stays open to later reads until a finalized success: confirmed, then missing, then Resume", async () => {
    const world = await confirmed();
    expect(world.record()?.seat).toMatchObject({ state: "landed" });
    expect(world.record()?.seat?.proven).toBeUndefined();
    world.rollup.statuses.delete(signatureOfAttempt(1));
    expect(await ask(world)).toMatchObject({ status: "waiting" });
    expect(world.solana.sent).toEqual([]);
    expect(world.record()).toBeDefined();
  });

  it("is not final on a confirmed error either: confirmed, then failed but not final, then Resume", async () => {
    const world = await confirmed();
    status(world, 1, "confirmed", REFUSED);
    expect(await ask(world)).toMatchObject({ status: "waiting" });
    expect(world.solana.sent).toEqual([]);
    expect(world.record()).toBeDefined();
  });

  it("goes on to the Solana step only at a finalized success", async () => {
    const world = await confirmed();
    status(world, 1, "finalized");
    expect(await ask(world)).toMatchObject({ status: "done" });
    expect(world.rows.size).toBe(0);
  });

  it("is final as recorded when the client proved it from the account's own view", async () => {
    const { world } = keyWorld([{ kind: "withdrawn" }]);
    expect(await ask(world)).toMatchObject({ status: "done" });
    expect(world.solana.sent).toHaveLength(1);
  });

  it("keeps the proof apart in the journal", async () => {
    const { world } = keyWorld([{ kind: "withdrawn" }]);
    const marked: string[] = [];
    const proven = world.env.journal.markSeatProven.bind(world.env.journal);
    const landed = world.env.journal.markSeatLanded.bind(world.env.journal);
    world.env.journal.markSeatProven = async (...args) => {
      marked.push("proven");
      return proven(...args);
    };
    world.env.journal.markSeatLanded = async (...args) => {
      marked.push("landed");
      return landed(...args);
    };
    await ask(world);
    expect(marked).toEqual(["proven"]);
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
