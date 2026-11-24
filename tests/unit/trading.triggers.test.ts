import { describe, expect, it } from "vitest";
import { fromFixedPoint } from "@/lib/trading/decimal";
import {
  bpsFromMark,
  DEFAULT_TRIGGER_SLIPPAGE_BPS,
  describePartialFailure,
  describeSaveScope,
  describeTriggerError,
  describeTriggerLine,
  describeUnfillable,
  estimatedPnl,
  formatBpsFromMark,
  planTriggerChanges,
  positionIsLong,
  priceFromBps,
  slippageBpsFromPercent,
  triggerExists,
  validateTriggerDraft,
  worstPriceFor,
  type TriggerDraft,
  type TriggerMarketContext,
} from "@/lib/trading/triggers";
import { DEFAULT_SLIPPAGE_BPS } from "@/lib/trading/marketBound";

const LONG: TriggerMarketContext = {
  long: true,
  mark: "150.00",
  tick: "0.01",
  lot: "0.001",
  positionSize: "2.5",
  minSize: "0.01",
  bandBps: 400,
};
const SHORT: TriggerMarketContext = { ...LONG, long: false };

const EMPTY: TriggerDraft = {
  takeProfit: "",
  stopLoss: "",
  whole: true,
  size: "",
  slippagePercent: "1",
};

describe("which side of the mark each trigger belongs on", () => {
  it("puts a long's take profit above the mark and its stop loss below", () => {
    expect(validateTriggerDraft({ ...EMPTY, takeProfit: "160", stopLoss: "140" }, LONG)).toEqual(
      {},
    );
    expect(validateTriggerDraft({ ...EMPTY, takeProfit: "140" }, LONG).takeProfit).toBe(
      "priceWrongSide",
    );
    expect(validateTriggerDraft({ ...EMPTY, stopLoss: "160" }, LONG).stopLoss).toBe(
      "priceWrongSide",
    );
  });

  it("mirrors it for a short", () => {
    expect(validateTriggerDraft({ ...EMPTY, takeProfit: "140", stopLoss: "160" }, SHORT)).toEqual(
      {},
    );
    expect(validateTriggerDraft({ ...EMPTY, takeProfit: "160" }, SHORT).takeProfit).toBe(
      "priceWrongSide",
    );
    expect(validateTriggerDraft({ ...EMPTY, stopLoss: "140" }, SHORT).stopLoss).toBe(
      "priceWrongSide",
    );
  });

  it("refuses a price at the mark itself, which would fire at once", () => {
    expect(validateTriggerDraft({ ...EMPTY, takeProfit: "150.00" }, LONG).takeProfit).toBe(
      "priceWrongSide",
    );
  });

  it("leaves an empty price alone: that trigger is simply not set", () => {
    expect(validateTriggerDraft(EMPTY, LONG)).toEqual({});
  });

  it("needs a fresh mark to judge any price", () => {
    expect(validateTriggerDraft({ ...EMPTY, takeProfit: "160" }, { ...LONG, mark: null })).toEqual({
      takeProfit: "markUnavailable",
    });
  });
});

describe("price checks", () => {
  it("rejects text, zero and negatives", () => {
    for (const bad of ["abc", "0", "-5", "1e3", "."]) {
      expect(validateTriggerDraft({ ...EMPTY, stopLoss: bad }, LONG).stopLoss, bad).toBe(
        "priceNotANumber",
      );
    }
  });

  it("keeps a price on the market's tick", () => {
    expect(validateTriggerDraft({ ...EMPTY, takeProfit: "160.005" }, LONG).takeProfit).toBe(
      "priceNotOnTick",
    );
    expect(validateTriggerDraft({ ...EMPTY, takeProfit: "160.01" }, LONG)).toEqual({});
  });
});

describe("size checks", () => {
  const sized = (size: string): TriggerDraft => ({ ...EMPTY, whole: false, size });

  it("takes any whole position without a typed size", () => {
    expect(validateTriggerDraft({ ...EMPTY, size: "junk" }, LONG)).toEqual({});
  });

  it("needs an amount above zero", () => {
    expect(validateTriggerDraft(sized(""), LONG).size).toBe("sizeRequired");
    expect(validateTriggerDraft(sized("0"), LONG).size).toBe("sizeRequired");
  });

  it("keeps the amount on the lot, above the minimum and inside the position", () => {
    expect(validateTriggerDraft(sized("0.0015"), LONG).size).toBe("sizeNotOnLot");
    expect(validateTriggerDraft(sized("0.005"), LONG).size).toBe("sizeBelowMinimum");
    expect(validateTriggerDraft(sized("2.501"), LONG).size).toBe("sizeAbovePosition");
    expect(validateTriggerDraft(sized("2.5"), LONG)).toEqual({});
    expect(validateTriggerDraft(sized("0.01"), LONG)).toEqual({});
  });
});

describe("slippage checks", () => {
  it("needs a number above zero", () => {
    expect(validateTriggerDraft({ ...EMPTY, slippagePercent: "" }, LONG).slippage).toBe(
      "slippageInvalid",
    );
    expect(validateTriggerDraft({ ...EMPTY, slippagePercent: "0" }, LONG).slippage).toBe(
      "slippageInvalid",
    );
  });

  it("stops at the market's crossing band, or at the order price limit while the band is unread", () => {
    expect(validateTriggerDraft({ ...EMPTY, slippagePercent: "4" }, LONG)).toEqual({});
    expect(validateTriggerDraft({ ...EMPTY, slippagePercent: "4.01" }, LONG).slippage).toBe(
      "slippageTooWide",
    );
    const unread = { ...LONG, bandBps: undefined };
    expect(validateTriggerDraft({ ...EMPTY, slippagePercent: "10" }, unread)).toEqual({});
    expect(validateTriggerDraft({ ...EMPTY, slippagePercent: "10.5" }, unread).slippage).toBe(
      "slippageTooWide",
    );
  });

  it("converts percent text to whole basis points", () => {
    expect(slippageBpsFromPercent("1")).toBe(100);
    expect(slippageBpsFromPercent("0.25")).toBe(25);
    expect(slippageBpsFromPercent("nope")).toBeNull();
    expect(slippageBpsFromPercent("0.001")).toBeNull();
  });

  it("starts from the same distance a market order's worst price uses", () => {
    expect(DEFAULT_TRIGGER_SLIPPAGE_BPS).toBe(DEFAULT_SLIPPAGE_BPS);
  });
});

describe("distance from the mark", () => {
  it("measures it in signed basis points and prints it as a percent", () => {
    expect(bpsFromMark("157.50", "150.00")).toBe(500);
    expect(bpsFromMark("147.00", "150.00")).toBe(-200);
    expect(bpsFromMark("150", "0")).toBeNull();
    expect(formatBpsFromMark(500)).toBe("+5.00%");
    expect(formatBpsFromMark(-200)).toBe("-2.00%");
    expect(formatBpsFromMark(0)).toBe("0.00%");
  });

  it("turns a percentage back into a price on the tick", () => {
    expect(priceFromBps(500, "150.00", "0.01", 2)).toBe("157.50");
    expect(priceFromBps(-200, "150.00", "0.01", 2)).toBe("147.00");
    expect(priceFromBps(333, "151.37", "0.05", 2)).toBe("156.40");
    expect(priceFromBps(-10_000, "150.00", "0.01", 2)).toBeNull();
    expect(priceFromBps(100, "nope", "0.01", 2)).toBeNull();
  });
});

describe("estimated profit and loss", () => {
  const pnl = (params: Parameters<typeof estimatedPnl>[0]) => {
    const value = estimatedPnl(params);
    return value === null ? null : fromFixedPoint(value, 2);
  };

  it("pays a long for a rise and charges it for a fall", () => {
    expect(pnl({ long: true, entry: "148", price: "160", size: "2.5" })).toBe("30.00");
    expect(pnl({ long: true, entry: "148", price: "140", size: "2.5" })).toBe("-20.00");
  });

  it("pays a short for a fall and charges it for a rise", () => {
    expect(pnl({ long: false, entry: "148", price: "140", size: "2.5" })).toBe("20.00");
    expect(pnl({ long: false, entry: "148", price: "160", size: "2.5" })).toBe("-30.00");
  });

  it("scales with the size chosen and says nothing it cannot work out", () => {
    expect(pnl({ long: true, entry: "148", price: "160", size: "1" })).toBe("12.00");
    expect(pnl({ long: true, entry: "x", price: "160", size: "1" })).toBeNull();
    expect(pnl({ long: true, entry: "148", price: "160", size: "-1" })).toBeNull();
  });

  it("reads a position's direction from its sign", () => {
    expect(positionIsLong("2.5")).toBe(true);
    expect(positionIsLong("-2.5")).toBe(false);
  });
});

describe("the worst price a trigger may fill at", () => {
  it("sits below a long's trigger, rounded down to the tick", () => {
    expect(
      worstPriceFor({
        triggerPrice: "160.00",
        long: true,
        slippageBps: 100,
        tick: "0.01",
        priceDecimals: 2,
      }),
    ).toBe("158.40");
    expect(
      worstPriceFor({
        triggerPrice: "161.37",
        long: true,
        slippageBps: 100,
        tick: "0.05",
        priceDecimals: 2,
      }),
    ).toBe("159.75");
  });

  it("sits above a short's trigger, rounded up to the tick", () => {
    expect(
      worstPriceFor({
        triggerPrice: "140.00",
        long: false,
        slippageBps: 100,
        tick: "0.01",
        priceDecimals: 2,
      }),
    ).toBe("141.40");
    expect(
      worstPriceFor({
        triggerPrice: "140.03",
        long: false,
        slippageBps: 100,
        tick: "0.05",
        priceDecimals: 2,
      }),
    ).toBe("141.45");
  });

  it("gives nothing for a price it cannot read", () => {
    expect(
      worstPriceFor({
        triggerPrice: "?",
        long: true,
        slippageBps: 100,
        tick: "0.01",
        priceDecimals: 2,
      }),
    ).toBeNull();
  });
});

describe("what saving sends", () => {
  const initial: TriggerDraft = { ...EMPTY, takeProfit: "160", stopLoss: "140" };
  const nothingRemoved = { takeProfit: false, stopLoss: false };
  const both = { takeProfit: true, stopLoss: true };

  it("sends nothing when nothing changed", () => {
    expect(
      planTriggerChanges({ draft: initial, initial, exists: both, remove: nothingRemoved }),
    ).toEqual([]);
  });

  it("sets only the price that changed", () => {
    expect(
      planTriggerChanges({
        draft: { ...initial, takeProfit: "165" },
        initial,
        exists: both,
        remove: nothingRemoved,
      }),
    ).toEqual([{ op: "set", kind: "takeProfit" }]);
  });

  it("sets both when the size or slippage they share changed", () => {
    expect(
      planTriggerChanges({
        draft: { ...initial, slippagePercent: "2" },
        initial,
        exists: both,
        remove: nothingRemoved,
      }),
    ).toEqual([
      { op: "set", kind: "takeProfit" },
      { op: "set", kind: "stopLoss" },
    ]);
    expect(
      planTriggerChanges({
        draft: { ...initial, whole: false, size: "1" },
        initial,
        exists: both,
        remove: nothingRemoved,
      }),
    ).toHaveLength(2);
  });

  it("sets a price filled in where none exists", () => {
    expect(
      planTriggerChanges({
        draft: { ...EMPTY, stopLoss: "140" },
        initial: EMPTY,
        exists: { takeProfit: false, stopLoss: false },
        remove: nothingRemoved,
      }),
    ).toEqual([{ op: "set", kind: "stopLoss" }]);
  });

  it("removes before it sets, and removes what was cleared", () => {
    expect(
      planTriggerChanges({
        draft: { ...initial, takeProfit: "", stopLoss: "135" },
        initial,
        exists: both,
        remove: nothingRemoved,
      }),
    ).toEqual([
      { op: "cancel", kind: "takeProfit" },
      { op: "set", kind: "stopLoss" },
    ]);
  });

  it("removes a trigger set on another device only when Remove was pressed", () => {
    const other = { ...EMPTY };
    expect(
      planTriggerChanges({
        draft: other,
        initial: other,
        exists: { takeProfit: true, stopLoss: false },
        remove: nothingRemoved,
      }),
    ).toEqual([]);
    expect(
      planTriggerChanges({
        draft: other,
        initial: other,
        exists: { takeProfit: true, stopLoss: false },
        remove: { takeProfit: true, stopLoss: false },
      }),
    ).toEqual([{ op: "cancel", kind: "takeProfit" }]);
  });

  it("does not send a removal for a trigger that is not there", () => {
    expect(
      planTriggerChanges({
        draft: { ...initial, takeProfit: "" },
        initial,
        exists: { takeProfit: false, stopLoss: true },
        remove: nothingRemoved,
      }),
    ).toEqual([]);
  });
});

describe("what the exchange's report is shown as", () => {
  const formatTime = (ms: number) => `t${ms}`;
  const local = {
    price: "160.00",
    size: null,
    slippageBps: 100,
    long: true,
    setAtMs: 1_000,
  };
  const line = (
    chain: Parameters<typeof describeTriggerLine>[0]["chain"],
    withLocal = true,
    readAtMs: number | null = 2_000,
  ) =>
    describeTriggerLine({
      kind: "takeProfit",
      chain,
      readAtMs,
      local: withLocal ? local : undefined,
      formatTime,
    });

  it("calls a live trigger armed and shows the price this device set", () => {
    expect(line({ state: "armed" })).toEqual({
      kind: "takeProfit",
      price: "160.00",
      setAtMs: 1_000,
      status: "Armed",
      tone: "ok",
      detail: null,
    });
  });

  it("shows a trigger set on another device without a price", () => {
    expect(line({ state: "armed" }, false)).toMatchObject({ price: null, status: "Armed" });
  });

  it("says a trigger that cannot place an order at its size cannot close at that size, with when it tries next", () => {
    expect(line({ state: "unfillable", nextAttemptMs: 5 })).toMatchObject({
      status: "Cannot close at this size",
      tone: "warn",
      detail: "Next try t5.",
    });
    expect(line({ state: "unfillable" })).toMatchObject({ detail: null });
  });

  it("says open orders hold the margin without promising a fix", () => {
    expect(line({ state: "blockedByRestingOrders", nextAttemptMs: 9 })).toMatchObject({
      status: "Blocked by your open orders",
      tone: "warn",
      detail: "Next try t9.",
    });
  });

  it("shows nothing for a trigger the exchange reports gone", () => {
    expect(line({ state: "gone" })).toBeNull();
    expect(line({ state: "gone" }, false)).toBeNull();
  });

  it("does not take a read from before the trigger was set for its absence", () => {
    expect(line({ state: "gone" }, true, 500)).toMatchObject({ status: "Checking" });
  });

  it("shows only a remembered price, marked as unconfirmed, before the exchange has been asked", () => {
    expect(line(null)).toMatchObject({ price: "160.00", status: "Checking", tone: "muted" });
    expect(line(null, false)).toBeNull();
  });

  it("never shows a stale read as live: it says when the trigger was last checked", () => {
    const stale = (chain: Parameters<typeof describeTriggerLine>[0]["chain"], withLocal = true) =>
      describeTriggerLine({
        kind: "takeProfit",
        chain,
        readAtMs: 2_000,
        local: withLocal ? local : undefined,
        formatTime,
        stale: true,
        formatCheckTime: (ms) => `at${ms}`,
      });
    expect(stale({ state: "armed" })).toMatchObject({
      status: "Set, last checked at2000",
      tone: "muted",
    });
    expect(stale({ state: "unfillable", nextAttemptMs: 5 })).toMatchObject({
      status: "Set, last checked at2000",
      detail: null,
    });
    expect(stale({ state: "armed" }, false)).toMatchObject({ price: null });
    expect(stale({ state: "gone" })).toMatchObject({ status: "Set, last checked at2000" });
    expect(stale({ state: "gone" }, false)).toBeNull();
  });

  it("explains an unfillable trigger by its size, and promises a retry only when one is scheduled", () => {
    const scheduled = describeUnfillable(
      "stopLoss",
      { state: "unfillable", nextAttemptMs: 5 },
      formatTime,
    );
    expect(scheduled).toContain("cannot close at its size");
    expect(scheduled).toContain("Whole position or another amount");
    expect(scheduled).toContain("tries again at t5");
    const unscheduled = describeUnfillable("stopLoss", { state: "unfillable" }, formatTime);
    expect(unscheduled).not.toContain("tries again");
    expect(unscheduled).not.toMatch(/liquidity/);
  });

  it("counts a trigger as existing while it is reported live or remembered", () => {
    expect(triggerExists({ state: "armed" }, undefined)).toBe(true);
    expect(triggerExists({ state: "gone" }, undefined)).toBe(false);
    expect(triggerExists({ state: "gone" }, local)).toBe(true);
    expect(triggerExists(null, undefined)).toBe(false);
    expect(triggerExists(null, local)).toBe(true);
  });
});

describe("a save that went through only in part", () => {
  it("drops the sentence that says nothing was changed, since earlier steps were", () => {
    expect(
      describePartialFailure(
        { op: "set", kind: "takeProfit" },
        "The exchange did not accept this. Nothing was changed. Try again in a moment.",
      ),
    ).toBe("Take profit was not saved: The exchange did not accept this. Try again in a moment.");
    const text = describePartialFailure(
      { op: "set", kind: "takeProfit" },
      "Expired. Nothing was changed.",
    );
    expect(text).toBe("Take profit was not saved: Expired.");
    expect(text).not.toContain("Nothing was changed");
    expect(describePartialFailure({ op: "cancel", kind: "stopLoss" }, "Busy.")).toBe(
      "Stop loss was not removed: Busy.",
    );
  });
});

describe("which triggers a save updates", () => {
  const exists = { takeProfit: true, stopLoss: true };
  const entry = { price: "1", size: null, slippageBps: 100, long: true, setAtMs: 1 };

  it("says nothing for plain sets, since the Save button already says it", () => {
    expect(
      describeSaveScope({
        changes: [{ op: "set", kind: "stopLoss" }],
        exists,
        local: { takeProfit: entry, stopLoss: entry },
      }),
    ).toEqual([]);
    expect(
      describeSaveScope({
        changes: [
          { op: "set", kind: "takeProfit" },
          { op: "set", kind: "stopLoss" },
        ],
        exists,
        local: { takeProfit: entry, stopLoss: entry },
      }),
    ).toEqual([]);
  });

  it("says a trigger set elsewhere has a size and slippage unknown here", () => {
    expect(
      describeSaveScope({
        changes: [{ op: "set", kind: "stopLoss" }],
        exists,
        local: { stopLoss: entry },
      }),
    ).toEqual(["Take profit was set on another device: its size and slippage are unknown here."]);
  });

  it("lists removals and says nothing when nothing is saved", () => {
    expect(
      describeSaveScope({
        changes: [{ op: "cancel", kind: "takeProfit" }],
        exists,
        local: { takeProfit: entry, stopLoss: entry },
      }),
    ).toEqual(["Removing: take profit."]);
    expect(describeSaveScope({ changes: [], exists, local: {} })).toEqual([]);
  });
});

describe("the words for a field error", () => {
  const context = { ...LONG, base: "SOL", quote: "USDC" };

  it("names the side a price belongs on", () => {
    expect(describeTriggerError("priceWrongSide", "takeProfit", context)).toBe(
      "A take profit on a long has to sit above the mark price.",
    );
    expect(describeTriggerError("priceWrongSide", "stopLoss", context)).toBe(
      "A stop loss on a long has to sit below the mark price.",
    );
    expect(describeTriggerError("priceWrongSide", "stopLoss", { ...context, long: false })).toBe(
      "A stop loss on a short has to sit above the mark price.",
    );
  });

  it("gives every error a sentence with no dash, code or empty gap", () => {
    const all = [
      "priceNotANumber",
      "priceNotOnTick",
      "priceWrongSide",
      "markUnavailable",
      "sizeRequired",
      "sizeNotOnLot",
      "sizeBelowMinimum",
      "sizeAbovePosition",
      "slippageInvalid",
      "slippageTooWide",
    ] as const;
    for (const error of all) {
      const text = describeTriggerError(error, "takeProfit", context);
      expect(text.length, error).toBeGreaterThan(10);
      expect(text, error).toMatch(/\.$/);
      expect(text, error).not.toMatch(/[–—]/);
      expect(text, error).not.toMatch(/undefined|NaN/);
    }
  });
});
