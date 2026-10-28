import { describe, expect, it } from "vitest";
import { actionsOf, attentionOf } from "@/lib/transfer/attention";
import { deposit, recoverDepositKey } from "@/lib/transfer/deposit";
import { outcomeLine, solText } from "@/lib/transfer/outcomeCopy";
import { canStartTransfer } from "@/lib/transfer/resume";
import { SOLANA_EXIT_LAMPORTS } from "@/lib/transfer/operation";
import { finishCompleted, withdraw } from "@/lib/transfer/withdraw";
import { USDC, makeWorld, staleMark, type World } from "./transferWorld";

const ATOMS = 2_500_000n;
const FREE = 5n * USDC;

const ask = (world: World, intent?: Parameters<typeof withdraw>[1]["intent"]) =>
  withdraw(world.env, { amount: "2.5", freeCollateral: FREE, intent });

/** After a stop, a new transfer may start: nothing on record blocks it. */
async function expectNothingBlocks(world: World) {
  expect(world.rows.size).toBe(0);
  world.solana.script({ fate: "land", effect: world.moveEffect(ATOMS) });
  world.rollup.script({ fate: "land", effect: world.depositEffect(ATOMS) });
  expect(await deposit(world.env, { amount: "2.5", intent: { kind: "new" } })).toMatchObject({
    status: "done",
  });
}

describe("a withdrawal that stops having sent nothing leaves no record", () => {
  it("after a stale price", async () => {
    const world = makeWorld();
    world.delegate(0n);
    world.rollup.simulateAnswers.push(...Array.from({ length: 100 }, () => staleMark));
    expect(await ask(world, { kind: "new" })).toMatchObject({
      status: "refused",
      reason: "stale-price",
    });
    await expectNothingBlocks(world);
  });

  it("after the network would refuse the withdrawal", async () => {
    const world = makeWorld();
    world.delegate(0n);
    world.rollup.simulateAnswers.push({ InstructionError: [0, { Custom: 6001 }] });
    expect(await ask(world, { kind: "new" })).toMatchObject({
      status: "refused",
      reason: "rollup-refused",
    });
    await expectNothingBlocks(world);
  });

  it("after the balance turns out to be delegated elsewhere", async () => {
    const world = makeWorld();
    world.delegate(0n, world.env.owner);
    expect(await ask(world, { kind: "new" })).toMatchObject({ reason: "delegated-elsewhere" });
    await expectNothingBlocks(world);
  });

  it("after a sealed custody with no balance to pay into", async () => {
    const world = makeWorld();
    world.env.sealed = true;
    expect(await ask(world, { kind: "new" })).toMatchObject({ reason: "sealed-balance-missing" });
    await expectNothingBlocks(world);
  });

  it("after the owner's token account in the rollup cannot be read", async () => {
    const world = makeWorld();
    world.delegate(0n);
    world.rollup.accounts.delete(world.wallet.toBase58());
    expect(await ask(world, { kind: "new" })).toMatchObject({ reason: "rollup-unreadable" });
    await expectNothingBlocks(world);
  });

  it("after the simulation call fails, which is not the network refusing the transaction", async () => {
    const world = makeWorld();
    world.delegate(0n);
    world.rollup.simulateTransaction = async () => {
      throw new Error("429 Too Many Requests");
    };
    const outcome = await ask(world, { kind: "new" });
    expect(outcome).toMatchObject({ status: "refused", reason: "simulation-unavailable" });
    expect(outcomeLine("withdraw", outcome, 6, SOLANA_EXIT_LAMPORTS).text).toBe(
      "Could not check the transaction with the network. Nothing was sent. Try again in a moment.",
    );
    await expectNothingBlocks(world);
  });

  it("after the wallet declines to sign", async () => {
    const world = makeWorld();
    world.delegate(0n);
    const signs = world.env.signChecked;
    world.env.signChecked = async () => {
      throw new Error("User rejected the request");
    };
    await expect(ask(world, { kind: "new" })).rejects.toThrow(/rejected/);
    world.env.signChecked = signs;
    await expectNothingBlocks(world);
  });

  it("after a token account setup that is final, and keeps the record while that setup may still be undone", async () => {
    for (const commitment of ["finalized", "confirmed"] as const) {
      const world = makeWorld();
      world.fund({ onSolana: 0n });
      world.solana.script({ fate: "land", effect: () => world.delegate(0n), commitment });
      world.rollup.simulateAnswers.push(...Array.from({ length: 100 }, () => staleMark));
      expect(await ask(world, { kind: "new" })).toMatchObject({ reason: "stale-price" });
      expect(world.solana.sent).toHaveLength(1);
      expect(world.rows.size, commitment).toBe(commitment === "finalized" ? 0 : 1);
    }
  });

  it("but keeps it once the seat's withdrawal ran, and says where the USDC is", async () => {
    const world = makeWorld();
    world.delegate(0n);
    world.fund({ onSolana: 0n });
    world.rollup.script({ fate: "land", effect: world.seatEffect(ATOMS) });
    world.solana.simulateAnswers.push({ InstructionError: [0, { Custom: 1 }] });
    const outcome = await ask(world, { kind: "new" });
    expect(outcome).toMatchObject({
      status: "refused",
      reason: "simulation-failed",
      inRollup: true,
    });
    expect(world.record()?.seat?.state).toBe("landed");
    const text = outcomeLine("withdraw", outcome, 6, SOLANA_EXIT_LAMPORTS).text;
    expect(text).not.toMatch(/Nothing moved/);
    expect(text).toContain("Your USDC left your trading account and is on its way to your wallet.");
    expect(text).toContain("Press Resume under transfers that need attention");
    const record = world.record()!;
    expect(actionsOf(attentionOf(record, "landed", [record]))).toContain("resume");
    world.solana.script({ fate: "land", effect: world.shuttleEffect(ATOMS) });
    expect(await ask(world, { kind: "resume", id: record.id, atoms: record.atoms })).toMatchObject({
      status: "done",
    });
  });
});

describe("a stop in the Solana leg after the seat leg moved the collateral", () => {
  const stoppedAfterSeat = async (reason: "insufficient-sol" | "send-failed") => {
    const world = makeWorld();
    world.delegate(0n);
    world.rollup.script({ fate: "land", effect: world.seatEffect(ATOMS) });
    if (reason === "insufficient-sol") {
      let calls = 0;
      world.solana.getBalance = async () => {
        calls += 1;
        return calls === 1 ? 1_000_000_000 : 1_000;
      };
    } else {
      world.solana.script({ fate: "fail" });
    }
    const outcome = await ask(world, { kind: "new" });
    expect(outcome).toMatchObject({ status: "refused", reason, inRollup: true });
    return outcomeLine("withdraw", outcome, 6, SOLANA_EXIT_LAMPORTS).text;
  };

  it("names the SOL it needs", async () => {
    const text = await stoppedAfterSeat("insufficient-sol");
    expect(text).toBe(
      `Your USDC left your trading account and is on its way to your wallet. Your wallet needs about ${solText(SOLANA_EXIT_LAMPORTS)} for network fees to finish it. Add SOL, then press Resume under transfers that need attention.`,
    );
  });

  it("does not tell the user to start again", async () => {
    const text = await stoppedAfterSeat("send-failed");
    expect(text).toBe(
      "Your USDC left your trading account and is on its way to your wallet. The last step did not go through. It is safe in your rollup balance. Press Resume under transfers that need attention to finish it.",
    );
    expect(text).not.toMatch(/start again|Nothing moved/);
  });
});

describe("resuming an empty withdrawal record", () => {
  it("never starts a new withdrawal with fresh prompts", async () => {
    const world = makeWorld();
    world.delegate(0n);
    await world.env.journal.record(world.owner, {
      id: "empty",
      kind: "withdraw",
      atoms: ATOMS.toString(),
      step: "withdraw",
      sends: [],
    });
    const outcome = await ask(world, { kind: "resume", id: "empty", atoms: ATOMS.toString() });
    expect(outcome).toMatchObject({ status: "refused", reason: "record-changed" });
    expect(world.events).not.toContain("sign");
    expect(world.rollup.sent).toEqual([]);
    expect(world.solana.sent).toEqual([]);
    expect(world.rows.size).toBe(0);
  });
});

describe("a deposit that is done at confirmed", () => {
  const confirmedDeposit = async () => {
    const world = makeWorld();
    world.solana.script({ fate: "land", effect: world.moveEffect(ATOMS), commitment: "confirmed" });
    world.rollup.script({
      fate: "land",
      effect: world.depositEffect(ATOMS),
      commitment: "confirmed",
    });
    const outcome = await deposit(world.env, { amount: "2.5", intent: { kind: "new" } });
    expect(outcome).toMatchObject({ status: "done" });
    return world;
  };

  it("is closed in the background once finalized, without a click", async () => {
    const world = await confirmedDeposit();
    expect(world.rows.size).toBe(1);
    await finishCompleted(world.env);
    expect(world.rows.size).toBe(1);
    const record = world.record()!;
    world.solana.statuses.set(record.sends[0].signature, {
      err: null,
      confirmationStatus: "finalized",
    });
    world.rollup.statuses.set(record.seat!.signature!, {
      err: null,
      confirmationStatus: "finalized",
    });
    await finishCompleted(world.env);
    expect(world.rows.size).toBe(0);
  });

  it("does not wait on the key's balance when resumed, since the deposit step is on record", async () => {
    const world = await confirmedDeposit();
    const record = world.record()!;
    const started = world.clock.now();
    const again = await deposit(world.env, {
      amount: "2.5",
      intent: { kind: "resume", id: record.id, atoms: record.atoms },
    });
    expect(again).toMatchObject({ status: "done" });
    expect(world.clock.now() - started).toBeLessThan(10_000);
    expect(world.solana.sent).toHaveLength(1);
    expect(world.rollup.sent).toHaveLength(1);
  });
});

describe("copy for the unknown outcome and the stopped deposit", () => {
  it("names the signature it tells the user to send to support", () => {
    const text = outcomeLine(
      "deposit",
      {
        status: "unknown",
        id: "t1",
        subject: "rollup-send",
        message: "x",
        signature: "5abc",
        answers: [],
      },
      6,
      1,
    ).text;
    expect(text).toBe(
      "We cannot tell what happened to this deposit. Wait, or contact support with the signature 5abc. Nothing is sent again.",
    );
  });

  it("names the transfer id instead when there is no signature", () => {
    const text = outcomeLine(
      "withdraw",
      { status: "unknown", id: "t1", subject: "rollup-send", message: "x", answers: [] },
      6,
      1,
    ).text;
    expect(text).toBe(
      "We cannot tell what happened to this withdrawal. Wait, or contact support with the transfer id t1. Nothing is sent again.",
    );
    expect(text).not.toMatch(/signature/);
  });

  it("does not say nothing moved for a deposit whose last step did not go through", () => {
    const text = outcomeLine(
      "deposit",
      { status: "not-landed", id: "t1", signature: "5abc", message: "x" },
      6,
      1,
    ).text;
    expect(text).toContain("Your USDC already left your wallet and is safe in the rollup.");
    expect(text).not.toMatch(/Nothing moved/);
  });

  it("keeps saying nothing moved for a withdrawal that did not go through", () => {
    const text = outcomeLine(
      "withdraw",
      { status: "not-landed", id: "t1", signature: "5abc", message: "x" },
      6,
      1,
    ).text;
    expect(text).toContain("Nothing moved by it.");
  });
});

describe("the record rows and the buttons", () => {
  const record = (overrides = {}) => ({
    id: "t1",
    kind: "deposit" as const,
    atoms: "1",
    step: "deposit",
    sends: [],
    depositKey: "k",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });

  it("offers a retry, not a dead end, when a pending row's status could not be read", () => {
    const pending = record({
      seat: { state: "pending", at: "t", id: "s", before: "0", signature: "x" },
    });
    const attention = attentionOf(pending, "unreadable", [pending]);
    expect(attention).toMatchObject({ kind: "waiting", resumable: true, returnable: false });
    expect(actionsOf(attention)).toContain("resume");
  });

  it("still offers nothing for a send that cannot be placed", () => {
    const pending = record({ seat: { state: "pending", at: "t", id: "s", before: "0" } });
    expect(actionsOf(attentionOf(pending, "unknown", [pending]))).not.toContain("resume");
  });

  it("offers nothing to press on the row of the transfer this tab is running", () => {
    const pending = record({ seat: { state: "landed", at: "t", id: "s", before: "0" } });
    const attention = attentionOf(pending, "landed", [pending]);
    expect(actionsOf(attention)).toContain("resume");
    expect(actionsOf(attention, true)).not.toContain("resume");
    expect(actionsOf(attention, true)).not.toContain("return");
    expect(actionsOf(attention, true)).not.toContain("dismiss");
  });

  it("disables Deposit and Withdraw until the account settings are known", () => {
    const ready = {
      running: false,
      blocked: false,
      amountOk: true,
      accountOpen: true,
      settingsKnown: true,
    };
    expect(canStartTransfer(ready)).toBe(true);
    expect(canStartTransfer({ ...ready, settingsKnown: false })).toBe(false);
    expect(canStartTransfer({ ...ready, running: true })).toBe(false);
    expect(canStartTransfer({ ...ready, blocked: true })).toBe(false);
    expect(canStartTransfer({ ...ready, amountOk: false })).toBe(false);
    expect(canStartTransfer({ ...ready, accountOpen: false })).toBe(false);
  });

  it("names the recover button after a refused recovery", async () => {
    const world = makeWorld();
    world.delegateKey(ATOMS);
    world.rollup.script({ fate: "fail" });
    const refused = await recoverDepositKey(world.env);
    expect(outcomeLine("deposit", refused, 6, 1).text).toContain('"Put it in my account"');
  });
});
