import { describe, expect, it } from "vitest";
import { describeOpenOutcome, keysMayNotPersist, keysNotice } from "@/lib/trading/openCopy";
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

describe("keysMayNotPersist", () => {
  it("warns only when the browser said it cannot keep the seed", () => {
    expect(keysMayNotPersist({ stage: "ready", seedPersisted: false })).toBe(true);
    expect(keysMayNotPersist({ stage: "ready", seedPersisted: true })).toBe(false);
    expect(keysMayNotPersist({ stage: "ready", seedPersisted: null })).toBe(false);
    expect(keysMayNotPersist(null)).toBe(false);
  });
});
