import { describe, expect, it, vi } from "vitest";
import { actionsOf, attentionOf, type SeatJudgement } from "@/lib/transfer/attention";
import type { OperationRecord } from "@/lib/transfer/journal";
import type { TransferEnv } from "@/lib/transfer/operation";
import { outcomeLine } from "@/lib/transfer/outcomeCopy";
import { newTransferBlocked, openTransfers, resumeRecord } from "@/lib/transfer/resume";

const env = {} as TransferEnv;
const HUNDRED = "100000000";

const seat = {
  state: "pending" as const,
  at: "2026-10-25T10:00:00.000Z",
  id: "seat1",
  before: "0",
  signature: "S".repeat(88),
  lastValidBlockHeight: 500,
};

const record = (overrides: Partial<OperationRecord>): OperationRecord => ({
  id: "op1",
  kind: "deposit",
  atoms: HUNDRED,
  step: "deposit",
  sends: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const flows = () => ({
  deposit: vi.fn(async () => ({ status: "busy" as const })),
  withdraw: vi.fn(async () => ({ status: "busy" as const })),
  returnToWallet: vi.fn(async () => ({ status: "busy" as const })),
});

describe("resuming an open record", () => {
  it("resumes a deposit after its first step with the recorded amount, whatever the wallet now holds", async () => {
    const sent = {
      signature: "sig",
      lastValidBlockHeight: 10,
      status: "finalized" as const,
      at: 1,
      before: HUNDRED,
      moved: HUNDRED,
    };
    const attention = attentionOf(record({ sends: [sent] }), null);
    expect(actionsOf(attention)).toContain("resume");
    const run = flows();
    await resumeRecord(env, attention, 0n, run, 6);
    expect(run.deposit).toHaveBeenCalledWith(env, {
      amount: "100.000000",
      intent: { kind: "resume", id: "op1", atoms: HUNDRED },
    });
    expect(run.withdraw).not.toHaveBeenCalled();
  });

  it("resumes a withdrawal after its seat step with the recorded amount", async () => {
    const attention = attentionOf(
      record({
        kind: "withdraw",
        step: "withdraw",
        atoms: "5000000",
        seat: { ...seat, state: "landed" },
      }),
      null,
    );
    expect(actionsOf(attention)).toContain("resume");
    const run = flows();
    await resumeRecord(env, attention, 0n, run, 6);
    expect(run.withdraw).toHaveBeenCalledWith(env, {
      amount: "5.000000",
      freeCollateral: 0n,
      intent: { kind: "resume", id: "op1", atoms: "5000000" },
    });
    expect(run.deposit).not.toHaveBeenCalled();
  });

  it("resumes a withdrawal whose rollup send is judged landed", () => {
    const attention = attentionOf(record({ kind: "withdraw", seat }), "landed");
    expect(actionsOf(attention)).toContain("resume");
  });

  it.each<SeatJudgement | null>(["unknown", "not-seen", "pending", null])(
    "offers no Resume for a rollup send judged %s",
    (judgement) => {
      const attention = attentionOf(record({ seat }), judgement);
      expect(actionsOf(attention)).not.toContain("resume");
    },
  );

  it("offers Resume, but not Return to wallet, for a return already begun", () => {
    const actions = actionsOf(attentionOf(record({ step: "return" }), null));
    expect(actions).toContain("resume");
    expect(actions).not.toContain("return");
  });

  it("refuses to run a record that is not resumable", async () => {
    const attention = attentionOf(record({ seat }), "unknown");
    const run = flows();
    await expect(resumeRecord(env, attention, 0n, run, 6)).rejects.toThrow();
    expect(run.deposit).not.toHaveBeenCalled();
  });
});

describe("a new transfer while a record is open", () => {
  it("is blocked by any open record or unreadable records, and free otherwise", () => {
    expect(newTransferBlocked([record({})], false)).toBe(true);
    expect(newTransferBlocked([], true)).toBe(true);
    expect(newTransferBlocked([], false)).toBe(false);
  });

  it("is not blocked by the deposit key's return of spare SOL alone, but still by a real record beside it", () => {
    const sweep = record({ id: "op1.sweep", step: "sweep" });
    expect(newTransferBlocked([sweep], false)).toBe(false);
    expect(newTransferBlocked([sweep, record({})], false)).toBe(true);
    expect(newTransferBlocked([sweep], true)).toBe(true);
  });

  it("does not show the return of spare SOL among the transfers that need attention", () => {
    const sweep = record({ id: "op1.sweep", step: "sweep" });
    const open = record({ id: "op2" });
    expect(openTransfers([sweep, open])).toEqual([open]);
    expect(openTransfers([sweep])).toEqual([]);
  });

  it("says a busy flow sent nothing, whoever holds the lock", () => {
    const line = outcomeLine("deposit", { status: "busy" }, 6, 30_000_000);
    expect(line.text).toBe(
      "This browser is still finishing another transfer for this wallet. Try again in a moment. Nothing was sent.",
    );
  });
});
