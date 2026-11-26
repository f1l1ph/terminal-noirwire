import { describe, expect, it } from "vitest";
import {
  ACCOUNT_NOT_SHOWN_AWAY,
  CANCELS_STOPS_NOTE,
  depositHelp,
  depositNeedsSol,
  describeOpenOutcome,
  deviceStatus,
  feeSolText,
  gateAsksForInvite,
  KEYS_ELSEWHERE_NOTICE,
  KEYS_ELSEWHERE_TITLE,
  KEYS_MOVED_TITLE,
  keysMayNotPersist,
  keysNotice,
  MOVE_TRADING_HERE,
  MOVING_FUNDS_AWAY_NOTE,
  recheckOffer,
  setupSteps,
  SWITCH_DEVICE_STEPS,
  SWITCH_DEVICE_TITLE,
  SWITCH_DEVICE_WARNING,
  withoutOpenOutcome,
} from "@/lib/trading/openCopy";
import type { OpenRefusal } from "@/lib/rollup/openClient";
import { ROUND_TRIP_LAMPORTS, SOLANA_EXIT_LAMPORTS } from "@/lib/transfer/operation";
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
      refused({ kind: "addressLimit" }),
      refused({ kind: "dailyCapReached" }),
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

  it.each([
    [
      "your wallet changed the transaction (it added 2 instructions)",
      "Nothing was sent: your wallet changed the transaction (it added 2 instructions). You can try again.",
    ],
    ["The wallet declined.", "Nothing was sent: the wallet declined. You can try again."],
    [
      "Your account could not be read, so it was not opened. Nothing was sent.",
      "Nothing was sent: your account could not be read, so it was not opened. You can try again.",
    ],
    ["RPC is down", "Nothing was sent: RPC is down. You can try again."],
  ])("words a not-sent reason once and cleanly: %s", (reason, line) => {
    expect(describeOpenOutcome({ kind: "notSent", reason }, "absent").text).toBe(line);
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
  it("says the keys are elsewhere or moved, and whether moving cancels stops", () => {
    expect(keysNotice({ stage: "elsewhere", cancelsStops: true, seedPersisted: true })).toEqual({
      kind: "elsewhere",
      cancelsStops: true,
    });
    expect(keysNotice({ stage: "elsewhere", cancelsStops: false, seedPersisted: true })).toEqual({
      kind: "elsewhere",
      cancelsStops: false,
    });
    expect(keysNotice({ stage: "moved", cancelsStops: true, seedPersisted: true })).toEqual({
      kind: "moved",
      cancelsStops: true,
    });
  });

  it("asks for the wallet while installing and shows nothing when ready or unknown", () => {
    expect(keysNotice({ stage: "installing", seedPersisted: true })).toEqual({
      kind: "installing",
    });
    expect(keysNotice({ stage: "ready", seedPersisted: true })).toBeNull();
    expect(keysNotice(null)).toBeNull();
  });
});

describe("deviceStatus", () => {
  it("is here only once the keys are ready", () => {
    expect(deviceStatus({ stage: "ready", seedPersisted: true })).toBe("here");
  });

  it("is elsewhere for elsewhere, moved and installing", () => {
    expect(deviceStatus({ stage: "elsewhere", cancelsStops: false, seedPersisted: true })).toBe(
      "elsewhere",
    );
    expect(deviceStatus({ stage: "moved", cancelsStops: true, seedPersisted: true })).toBe(
      "elsewhere",
    );
    expect(deviceStatus({ stage: "installing", seedPersisted: true })).toBe("elsewhere");
  });

  it("is unknown for failed keys and before any keys are known", () => {
    expect(deviceStatus({ stage: "failed", reason: "x", seedPersisted: true })).toBeNull();
    expect(deviceStatus(null)).toBeNull();
  });
});

describe("the device switch copy", () => {
  it("has the agreed wording and no em dash", () => {
    expect(KEYS_ELSEWHERE_TITLE).toBe("Trading is on another device");
    expect(KEYS_MOVED_TITLE).toBe("Trading moved to another device");
    expect(MOVE_TRADING_HERE).toBe("Move trading here");
    expect(CANCELS_STOPS_NOTE).toBe("Moving cancels your stop loss and take profit.");
    expect(SWITCH_DEVICE_WARNING.startsWith(CANCELS_STOPS_NOTE)).toBe(true);
    expect(KEYS_ELSEWHERE_NOTICE).toBe("Trading is on another device.");
    for (const text of [
      KEYS_ELSEWHERE_NOTICE,
      SWITCH_DEVICE_TITLE,
      SWITCH_DEVICE_WARNING,
      ...SWITCH_DEVICE_STEPS,
      KEYS_ELSEWHERE_TITLE,
      KEYS_MOVED_TITLE,
      MOVE_TRADING_HERE,
      CANCELS_STOPS_NOTE,
      ACCOUNT_NOT_SHOWN_AWAY,
      MOVING_FUNDS_AWAY_NOTE,
    ]) {
      expect(text).not.toMatch(/\u2014/);
    }
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
    expect(keysNotice(failed)).toEqual({ kind: "failed", reason: "x" });
  });
});

describe("setupSteps", () => {
  const elsewhere = { stage: "elsewhere", cancelsStops: false, seedPersisted: true } as const;
  const moved = { stage: "moved", cancelsStops: true, seedPersisted: true } as const;
  const installing = { stage: "installing", seedPersisted: true } as const;
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

  it("keeps the keys step current for every key stage that is not ready, even while the account read is pending", () => {
    for (const keys of [elsewhere, moved, installing]) {
      expect(states({ connected: true, status: "unknown", keys, funded: null })).toEqual([
        "done",
        "done",
        "done",
        "current",
        "upcoming",
      ]);
    }
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
      setupSteps({ connected: true, status: "open", keys: elsewhere, funded: true }).ready,
    ).toBe(false);
    expect(setupSteps({ connected: false, status: "open", keys: ready, funded: true }).ready).toBe(
      false,
    );
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

describe("gate refusals", () => {
  const textOf = (refusal: OpenRefusal) => describeOpenOutcome(refused(refusal), "absent").text;

  it("tells a per-address refusal apart from a full day, and neither from a busy service", () => {
    expect(textOf({ kind: "addressLimit" })).toBe(
      "Nothing was sent. This network address already opened an account today. Try again tomorrow, or from another connection.",
    );
    expect(textOf({ kind: "dailyCapReached" })).toBe(
      "Nothing was sent. All of today's new accounts are taken. New accounts open again at 00:00 UTC, so come back then.",
    );
    expect(textOf({ kind: "tryLater" })).toBe(
      "Nothing was sent. The service is busy or just starting. Try again in a few seconds.",
    );
  });

  it("does not show a status number for a request the service turned away", () => {
    const text = textOf({ kind: "rejected", status: 400 });
    expect(text).toBe("Something was wrong with the request. Reload the page and try again.");
    expect(text).not.toMatch(/400/);
  });
});

describe("depositHelp", () => {
  it("points to the Funds section only when deposits are open", () => {
    expect(depositHelp(true)).toContain("Funds section");
  });

  it("says the wallet needs SOL for network fees before the first deposit, with the real figures", () => {
    expect(feeSolText(ROUND_TRIP_LAMPORTS)).toBe("0.04 SOL");
    expect(feeSolText(SOLANA_EXIT_LAMPORTS)).toBe("0.02 SOL");
    expect(depositHelp(true)).toContain(
      "Your wallet also needs about 0.04 SOL for network fees on the deposit, and about 0.02 SOL again to withdraw.",
    );
  });

  it("rounds a fee up to the hundredth, never down", () => {
    expect(feeSolText(1)).toBe("0.01 SOL");
    expect(feeSolText(10_000_000)).toBe("0.01 SOL");
    expect(feeSolText(10_000_001)).toBe("0.02 SOL");
  });

  it("says the SOL is short, with the amount held, when the balance is known to be too low", () => {
    const text = depositHelp(true, 12_500_000n);
    expect(text).toContain("Your wallet holds 0.0125 SOL, and a deposit needs about 0.04 SOL");
    expect(text).toContain("Add some SOL first.");
    expect(text).toContain("Nothing is charged until you deposit.");
  });

  it("does not claim a shortage when the balance is unknown or enough", () => {
    expect(depositHelp(true, null)).not.toContain("Add some SOL first");
    expect(depositHelp(true, BigInt(ROUND_TRIP_LAMPORTS))).not.toContain("Add some SOL first");
    expect(depositHelp(true, BigInt(ROUND_TRIP_LAMPORTS) - 1n)).toContain("Add some SOL first");
  });

  it("says the wallet needs SOL exactly when the help line does", () => {
    for (const lamports of [
      null,
      0n,
      BigInt(ROUND_TRIP_LAMPORTS) - 1n,
      BigInt(ROUND_TRIP_LAMPORTS),
    ]) {
      expect(depositNeedsSol(lamports)).toBe(
        depositHelp(true, lamports).includes("Add some SOL first"),
      );
    }
    expect(depositNeedsSol(null)).toBe(false);
    expect(depositNeedsSol(0n)).toBe(true);
  });

  it("does not mention SOL when deposits are off", () => {
    expect(depositHelp(false, 0n)).not.toMatch(/SOL/);
  });

  it("says deposits are not open yet, and asks for nothing, when they are off", () => {
    const text = depositHelp(false);
    expect(text).toBe("Deposits open soon. You can explore the market until then.");
    expect(text).not.toMatch(/add usdc|funds section/i);
  });
});

describe("a declined sign-in", () => {
  it("offers a check again and does not count the wallet as verified", () => {
    expect(recheckOffer("declined", null)).toBe("check");
    const { steps } = setupSteps({ connected: true, status: "declined", keys: null, funded: null });
    expect(steps.find((step) => step.id === "verify")?.state).toBe("current");
  });
});

describe("the invite code", () => {
  it("has its own sentence when the address is invited with a code", () => {
    expect(describeOpenOutcome(refused({ kind: "inviteCodeNeeded" }), "absent")).toMatchObject({
      tone: "error",
      nothingSent: true,
      text: "Nothing was sent. This address was invited with a code. Enter the invite code you were given, then try again.",
    });
  });

  it("says a code that does not match is wrong, not that the address is unlisted", () => {
    expect(describeOpenOutcome(refused({ kind: "inviteCodeWrong" }), "absent").text).toBe(
      "Nothing was sent. That invite code does not match this address. Check it and try again.",
    );
  });

  it("asks for a code only after the gate showed it admits by invite", () => {
    expect(gateAsksForInvite(null)).toBe(false);
    expect(gateAsksForInvite({ kind: "notSent", reason: "x" })).toBe(false);
    expect(gateAsksForInvite(refused({ kind: "tryLater" }))).toBe(false);
    for (const kind of [
      "notInvited",
      "inviteCodeNeeded",
      "inviteCodeWrong",
      "inviteUsed",
    ] as const) {
      expect(gateAsksForInvite(refused({ kind }))).toBe(true);
    }
  });
});

describe("the deposit step on both layouts", () => {
  it("names the Funds section of the account panel, not a place below the chart", () => {
    expect(depositHelp(true)).toContain("in the Funds section of your account panel");
    expect(depositHelp(true)).not.toContain("below the chart");
  });
});
