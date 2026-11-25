import { describe, expect, it, vi } from "vitest";
import { markStopReasonAsked, mayAskStopReason, SetupFunnel } from "@/lib/setupFunnel";

function memoryStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  };
}

function funnel(store: ReturnType<typeof memoryStore> | null = memoryStore()) {
  let now = 1_000;
  const send = vi.fn();
  const subject = new SetupFunnel(
    () => now,
    () => store,
    send,
  );
  return {
    subject,
    send,
    store,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("SetupFunnel", () => {
  it("counts a step seen once per page load", () => {
    const { subject, send } = funnel();
    subject.seen("verify");
    subject.seen("verify");
    expect(send.mock.calls).toEqual([["setup_step_seen", { step: "verify" }]]);
  });

  it("counts a step finished in front of the visitor as done now", () => {
    const { subject, send } = funnel();
    subject.seen("open");
    subject.done("open");
    expect(send).toHaveBeenLastCalledWith("setup_step_done", { step: "open", how: "now" });
  });

  it("counts a step that was already done when the page loaded as done already", () => {
    const { subject, send } = funnel();
    subject.done("connect");
    expect(send).toHaveBeenLastCalledWith("setup_step_done", { step: "connect", how: "already" });
  });

  it("counts a step this browser finished on an earlier visit as already, even when seen first", () => {
    const store = memoryStore();
    const first = funnel(store);
    first.subject.seen("connect");
    first.subject.done("connect");
    const returning = funnel(store);
    returning.subject.seen("connect");
    returning.subject.done("connect");
    expect(returning.send).toHaveBeenLastCalledWith("setup_step_done", {
      step: "connect",
      how: "already",
    });
  });

  it("sends a step's done only once per page load", () => {
    const { subject, send } = funnel();
    subject.done("keys");
    subject.done("keys");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("still counts done when storage is unavailable or broken", () => {
    const missing = funnel(null);
    missing.subject.seen("open");
    missing.subject.done("open");
    expect(missing.send).toHaveBeenLastCalledWith("setup_step_done", { step: "open", how: "now" });

    const broken = funnel(memoryStore({ "noirwire.setup.stepsDone": "{not json" }));
    broken.subject.seen("open");
    broken.subject.done("open");
    expect(broken.send).toHaveBeenLastCalledWith("setup_step_done", { step: "open", how: "now" });

    const throwing = new SetupFunnel(
      () => 0,
      () => ({
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("denied");
        },
      }),
      vi.fn(),
    );
    expect(() => throwing.done("open")).not.toThrow();
  });

  it("stores only step ids", () => {
    const { subject, store } = funnel();
    subject.done("connect");
    subject.done("verify");
    expect(JSON.parse(store!.values.get("noirwire.setup.stepsDone")!)).toEqual([
      "connect",
      "verify",
    ]);
  });

  it("counts an action", () => {
    const { subject, send } = funnel();
    subject.acted("open");
    expect(send).toHaveBeenLastCalledWith("setup_action", { step: "open" });
  });

  it("times a failure from the press that started it", () => {
    const { subject, send, advance } = funnel();
    subject.seen("open");
    advance(60_000);
    subject.acted("open");
    advance(3_000);
    subject.failed("open", "invite_required");
    expect(send).toHaveBeenLastCalledWith("setup_failed", {
      step: "open",
      reason: "invite_required",
      took: "under_5s",
    });
  });

  it("times a failure with no press from when the step was seen", () => {
    const { subject, send, advance } = funnel();
    subject.seen("keys");
    advance(45_000);
    subject.failed("keys", "key_storage_unavailable");
    expect(send).toHaveBeenLastCalledWith("setup_failed", {
      step: "keys",
      reason: "key_storage_unavailable",
      took: "30_120s",
    });
  });

  it("times a failure on a step never seen from the page load", () => {
    const { subject, send, advance } = funnel();
    advance(200_000);
    subject.failed("verify", "wallet_declined");
    expect(send).toHaveBeenLastCalledWith("setup_failed", {
      step: "verify",
      reason: "wallet_declined",
      took: "over_120s",
    });
  });
});

describe("the stop-reason question", () => {
  it("is asked once per browser", () => {
    const store = memoryStore();
    expect(mayAskStopReason(store)).toBe(true);
    markStopReasonAsked(store);
    expect(mayAskStopReason(store)).toBe(false);
  });

  it("is never asked where storage cannot remember it", () => {
    expect(mayAskStopReason(null)).toBe(false);
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(mayAskStopReason(throwing)).toBe(false);
    expect(() => markStopReasonAsked(throwing)).not.toThrow();
  });
});
