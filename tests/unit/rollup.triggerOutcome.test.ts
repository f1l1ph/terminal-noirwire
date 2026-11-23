import { describe, expect, it } from "vitest";
import {
  triggerErrorToResult,
  triggerRefusalReason,
  triggerStatusesFrom,
  triggerToResult,
  TRIGGERS_NOT_LIVE_REASON,
} from "@/lib/rollup/triggerOutcome";
import { describeProgramError, PROGRAM_ERROR } from "@/lib/rollup/refusals";
import {
  ALL_KEYS_BUSY_MESSAGE,
  OutcomeUnknown,
  RESULT_STATUS_CODE,
  TransactionFailed,
  type OrderResult,
} from "@/lib/rollup/sdk";
import { TRIGGER_ERROR, TRIGGER_TRANSACTION_ERROR } from "@noirwire/orderbook";

const result = (overrides: Partial<OrderResult>): OrderResult =>
  ({ status: RESULT_STATUS_CODE.done, code: 0, ...overrides }) as OrderResult;

const failedWith = (code: number) =>
  new TransactionFailed("sig", { InstructionError: [0, { Custom: code }] });

describe("a trigger's refusal in plain words", () => {
  it("has a sentence for every trigger refusal, and none shows a code or a dash", () => {
    for (const [name, number] of Object.entries(TRIGGER_ERROR)) {
      const text = triggerRefusalReason(number);
      expect(text, name).toMatch(/Nothing was changed\./);
      expect(text, name).not.toMatch(/\b\d{3,4}\b/);
      expect(text, name).not.toMatch(/[–—]/);
    }
  });

  it("words the engine's refusals a trigger can meet for a trigger", () => {
    expect(triggerRefusalReason(PROGRAM_ERROR.noPosition)).toMatch(/no open position/);
    expect(triggerRefusalReason(PROGRAM_ERROR.notPerpMarket)).toMatch(/perpetual markets only/);
    expect(triggerRefusalReason(PROGRAM_ERROR.stalePrice)).toMatch(/set a trigger against/);
    expect(triggerRefusalReason(PROGRAM_ERROR.notSeated)).toBe(
      describeProgramError(PROGRAM_ERROR.notSeated),
    );
  });

  it("falls back to a generic line for a number it does not know", () => {
    expect(triggerRefusalReason(99_999)).toMatch(/did not accept/);
    expect(triggerRefusalReason(null)).toMatch(/did not accept/);
  });

  it("explains an upgrade in progress", () => {
    expect(TRIGGERS_NOT_LIVE_REASON).toMatch(/upgraded/);
  });
});

describe("a trigger's result", () => {
  it("is ok when the exchange ran it, whether or not it replaced one", () => {
    expect(triggerToResult(result({ cancelled: 1n }))).toEqual({ kind: "ok" });
    expect(triggerToResult(result({ cancelled: 0n }))).toEqual({ kind: "ok" });
  });

  it("is a refusal with its sentence when the program refused", () => {
    expect(
      triggerToResult(
        result({ status: RESULT_STATUS_CODE.refused, code: TRIGGER_ERROR.sizeBelowMinimum }),
      ),
    ).toEqual({ kind: "refused", reason: describeProgramError(TRIGGER_ERROR.sizeBelowMinimum) });
  });
});

describe("what a failed trigger call throws", () => {
  it("reads a failed transaction by its wire code", () => {
    expect(triggerErrorToResult(failedWith(TRIGGER_TRANSACTION_ERROR.bookTooSmall), 0)).toEqual({
      kind: "refused",
      reason: describeProgramError(TRIGGER_ERROR.bookTooSmall),
    });
  });

  it("gives a plain line when the failure carries no code", () => {
    const mapped = triggerErrorToResult(new TransactionFailed("sig", "boom"), 0);
    expect(mapped?.kind).toBe("refused");
  });

  it("says every order key is busy", () => {
    const mapped = triggerErrorToResult(new Error(ALL_KEYS_BUSY_MESSAGE), 0);
    expect(mapped).toMatchObject({ kind: "refused" });
  });

  it("leaves anything else to the caller", () => {
    expect(triggerErrorToResult(new Error("socket closed"), 0)).toBeNull();
  });

  it("holds a call whose outcome is unknown as pending, and settles it from what the venue says", async () => {
    const unknown = new OutcomeUnknown(
      1n,
      Promise.resolve({ ...result({ cancelled: 1n }), sentAt: 0, resultAt: 1 }),
    );
    const mapped = triggerErrorToResult(unknown, 123);
    expect(mapped?.kind).toBe("pending");
    if (mapped?.kind !== "pending") return;
    expect(mapped.pending.expiresAtMs).toBe(123);
    await expect(mapped.pending.settled).resolves.toEqual({ kind: "ok" });
  });

  it("settles a call that expired unrun as a refusal, never as success", async () => {
    const unknown = new OutcomeUnknown(1n, Promise.resolve(null));
    const mapped = triggerErrorToResult(unknown, 0);
    if (mapped?.kind !== "pending") throw new Error("expected pending");
    await expect(mapped.pending.settled).resolves.toMatchObject({ kind: "refused" });
  });
});

describe("the exchange's report on a market's triggers", () => {
  it("turns the retry time from seconds to milliseconds and stamps when it was read", () => {
    expect(
      triggerStatusesFrom(
        {
          marketId: 0,
          takeProfit: { state: "armed" },
          stopLoss: { state: "blockedByRestingOrders", nextAttempt: 100n },
        },
        42,
      ),
    ).toEqual({
      takeProfit: { state: "armed" },
      stopLoss: { state: "blockedByRestingOrders", nextAttemptMs: 100_000 },
      readAtMs: 42,
    });
  });

  it("leaves the retry time out when none has been made yet", () => {
    expect(
      triggerStatusesFrom(
        { marketId: 0, takeProfit: { state: "unfillable" }, stopLoss: { state: "gone" } },
        1,
      ).takeProfit,
    ).toEqual({ state: "unfillable" });
  });
});
