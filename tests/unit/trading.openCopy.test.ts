import { describe, expect, it } from "vitest";
import {
  depositHelp,
  describeOpenOutcome,
  keysMayNotPersist,
  keysNotice,
  keysSettleFraction,
  recheckOffer,
  setupSteps,
  withoutOpenOutcome,
} from "@/lib/trading/openCopy";
import type { OpenRefusal } from "@/lib/rollup/openClient";
import type { OpenAccountOutcome } from "@/lib/trading/types";

const refused = (refusal: OpenRefusal): OpenAccountOutcome => ({ kind: "refused", refusal });

describe("describeOpenOutcome", () => {
  it("treats an opened or already open account as done and not retryable", () => {
    for (const outcome of [
      { kind: "opened", reference: "sig" },
      { kind: "alreadyOpen" },
      refused({ kind: "accountOpen" }),
    ] as OpenAccountOutcome[]) {
      const notice = describeOpenOutcome(outcome, "open");
      expect(notice.tone).toBe("ok");
      expect(notice.canRetry).toBe(false);
    }
  });

  it("says nothing was sent, and allows a retry, for every refusal made before sending", () => {
    const beforeSending: OpenAccountOutcome[] = [
      { kind: "notSent", reason: "The wallet declined." },
      refused({ kind: "notInvited" }),
      refused({ kind: "inviteUsed" }),
      refused({ kind: "tryLater" }),
      refused({ kind: "tooManyToday" }),
      refused({ kind: "prepareExpired" }),
      refused({ kind: "unreachable" }),
      refused({ kind: "badAnswer" }),
    ];
    for (const outcome of beforeSending) {
      const notice = describeOpenOutcome(outcome, "absent");
      expect(notice.tone).toBe("error");
      expect(notice.nothingSent).toBe(true);
    }
    expect(describeOpenOutcome({ kind: "notSent", reason: "x" }, "absent").canRetry).toBe(true);
  });

  it("does not claim nothing was sent for a rejection it cannot place", () => {
    const notice = describeOpenOutcome(refused({ kind: "rejected", status: 400 }), "absent");
    expect(notice.nothingSent).toBe(false);
  });

  it("follows the account read after an answer that may have opened it", () => {
    const maybe = refused({ kind: "mayBeOpen" });
    expect(describeOpenOutcome(maybe, "open").tone).toBe("ok");
    const absent = describeOpenOutcome(maybe, "absent");
    const unknown = describeOpenOutcome(maybe, "unknown");
    expect(absent.tone).toBe("wait");
    expect(unknown.tone).toBe("wait");
    expect(absent.nothingSent).toBe(false);
    expect(absent.text).not.toBe(unknown.text);
  });
});

describe("keysNotice", () => {
  it("counts down to when the keys settle, never below zero", () => {
    const settling = { stage: "settling", readyAtMs: 10_000, seedPersisted: true } as const;
    expect(keysNotice(settling, 4_000)).toEqual({ kind: "settling", secondsLeft: 6 });
    expect(keysNotice(settling, 9_001)).toEqual({ kind: "settling", secondsLeft: 1 });
    expect(keysNotice(settling, 20_000)).toEqual({ kind: "settling", secondsLeft: 0 });
  });

  it("asks for the wallet while installing and shows nothing when ready or unknown", () => {
    expect(keysNotice({ stage: "installing", seedPersisted: true }, 0)).toEqual({
      kind: "installing",
    });
    expect(keysNotice({ stage: "ready", seedPersisted: true }, 0)).toBeNull();
    expect(keysNotice(null, 0)).toBeNull();
  });
});

describe("recheckOffer and the failed key stage", () => {
  const failed = { stage: "failed", reason: "x", seedPersisted: true } as const;
  const ready = { stage: "ready", seedPersisted: true } as const;

  it("offers a check for an unread account and a retry for failed keys", () => {
    expect(recheckOffer("unknown", null)).toBe("check");
    expect(recheckOffer("unknown", ready)).toBe("check");
    expect(recheckOffer("open", failed)).toBe("retry");
    expect(recheckOffer("unknown", failed)).toBe("retry");
  });

  it("offers nothing when there is nothing to retry", () => {
    expect(recheckOffer("open", ready)).toBeNull();
    expect(recheckOffer("absent", null)).toBeNull();
  });

  it("carries the reason of a failed setup", () => {
    expect(keysNotice(failed, 0)).toEqual({ kind: "failed", reason: "x" });
  });
});

describe("setupSteps", () => {
  const settling = { stage: "settling", readyAtMs: 10, seedPersisted: true } as const;
  const ready = { stage: "ready", seedPersisted: true } as const;
  const failed = { stage: "failed", reason: "x", seedPersisted: true } as const;
  const states = (input: Parameters<typeof setupSteps>[0]) =>
    setupSteps(input).steps.map((step) => step.state);

  it("starts at connecting a wallet", () => {
    expect(states({ connected: false, status: "unknown", keys: null, funded: null })).toEqual([
      "current",
      "upcoming",
      "upcoming",
      "upcoming",
      "upcoming",
    ]);
  });

  it("waits on the sign-in until the account has been read", () => {
    expect(states({ connected: true, status: "unknown", keys: null, funded: null })).toEqual([
      "done",
      "current",
      "upcoming",
      "upcoming",
      "upcoming",
    ]);
  });

  it("asks to open the account when none exists", () => {
    expect(states({ connected: true, status: "absent", keys: null, funded: null })).toEqual([
      "done",
      "done",
      "current",
      "upcoming",
      "upcoming",
    ]);
  });

  it("shows the key wait as the current step while the account read is still pending", () => {
    expect(states({ connected: true, status: "unknown", keys: settling, funded: null })).toEqual([
      "done",
      "done",
      "done",
      "current",
      "upcoming",
    ]);
    expect(states({ connected: true, status: "open", keys: failed, funded: null })[3]).toBe(
      "current",
    );
  });

  it("asks for a deposit once the keys are ready, and never reads an unknown balance as funded", () => {
    for (const funded of [false, null]) {
      const result = setupSteps({ connected: true, status: "open", keys: ready, funded });
      expect(result.steps[4].state).toBe("current");
      expect(result.ready).toBe(false);
    }
  });

  it("is ready only with an open account, ready keys and a funded balance", () => {
    expect(setupSteps({ connected: true, status: "open", keys: ready, funded: true }).ready).toBe(
      true,
    );
    expect(
      setupSteps({ connected: true, status: "open", keys: settling, funded: true }).ready,
    ).toBe(false);
    expect(setupSteps({ connected: false, status: "open", keys: ready, funded: true }).ready).toBe(
      false,
    );
  });
});

describe("keysSettleFraction", () => {
  it("runs from 0 to 1 over the wait and stays in range", () => {
    expect(keysSettleFraction(60, 60_000)).toBe(0);
    expect(keysSettleFraction(15, 60_000)).toBeCloseTo(0.75);
    expect(keysSettleFraction(0, 60_000)).toBe(1);
    expect(keysSettleFraction(90, 60_000)).toBe(0);
    expect(keysSettleFraction(1, 0)).toBe(1);
  });
});

describe("withoutOpenOutcome", () => {
  const outcome: OpenAccountOutcome = { kind: "notSent", reason: "x" };

  it("forgets the leaving wallet's outcome and leaves the rest of the flow and other wallets alone", () => {
    const flows = {
      a: { outcome, status: "absent" },
      b: { outcome, status: "open" },
    };
    expect(withoutOpenOutcome(flows, "a")).toEqual({
      a: { outcome: null, status: "absent" },
      b: { outcome, status: "open" },
    });
  });

  it("returns the same object when there is nothing to forget", () => {
    const flows = { a: { outcome: null } };
    expect(withoutOpenOutcome(flows, "a")).toBe(flows);
    expect(withoutOpenOutcome(flows, "missing")).toBe(flows);
  });
});

describe("keysMayNotPersist", () => {
  it("flags only when the browser said it cannot keep the seed", () => {
    expect(keysMayNotPersist({ stage: "ready", seedPersisted: false })).toBe(true);
    expect(keysMayNotPersist({ stage: "ready", seedPersisted: true })).toBe(false);
    expect(keysMayNotPersist({ stage: "ready", seedPersisted: null })).toBe(false);
    expect(keysMayNotPersist(null)).toBe(false);
  });
});

describe("depositHelp", () => {
  it("points to the Funds section only when deposits are open", () => {
    expect(depositHelp(true)).toContain("Funds section");
  });

  it("says deposits are not open yet, and asks for nothing, when they are off", () => {
    const text = depositHelp(false);
    expect(text).toBe("Deposits open soon. You can explore the market until then.");
    expect(text).not.toMatch(/add usdc|funds section/i);
  });
});
