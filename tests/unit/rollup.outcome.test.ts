import { describe, expect, it } from "vitest";
import {
  cancelErrorToResult,
  cancelToResult,
  placedToResult,
  thrownToResult,
} from "@/lib/rollup/outcome";
import {
  OrderInvalid,
  OutcomeUnknown,
  RESULT_STATUS_CODE,
  TransactionFailed,
  type OrderResult,
  type Placed,
  type View,
} from "@/lib/rollup/sdk";
import { marketUnitsFromLotSize } from "@/lib/rollup/units";

const UNITS = marketUnitsFromLotSize("0.001000"); // 1000 lots per SOL, matching NSOL-PERP
const FAKE_VIEW = {} as View;

function result(over: Partial<OrderResult>): OrderResult {
  return {
    clientOrderId: 1n,
    orderSeq: 0n,
    filled: 0n,
    filledNotional: 0n,
    rested: 0n,
    cancelled: 0n,
    fee: 0n,
    kind: 1,
    status: RESULT_STATUS_CODE.filled,
    code: 0,
    ...over,
  };
}

function placedResult(over: Partial<OrderResult>): Placed {
  return {
    outcome: "placed",
    clientOrderId: 1n,
    result: result(over),
    secret: new Uint8Array(16),
    view: FAKE_VIEW,
    sentAt: 100,
    resultAt: 142,
  };
}

describe("placedToResult: outcome status mapping", () => {
  it("maps a full fill, including the filled size back into base units, and carries sentAt/resultAt", () => {
    const placed = placedResult({ filled: 1_000n, status: RESULT_STATUS_CODE.filled });
    const mapped = placedToResult(placed, UNITS, 6);
    expect(mapped.status).toBe("filled");
    expect(mapped.filledSize).toBe("1.000000");
    expect(mapped.remainingSize).toBe("0.000000");
    expect(mapped.reason).toBeNull();
    expect(mapped.sentAtMs).toBe(100);
    expect(mapped.resultAtMs).toBe(142);
  });

  it("maps a resting order with no fill to open, carrying the order sequence as orderId", () => {
    const placed = placedResult({
      filled: 0n,
      rested: 500n,
      orderSeq: 42n,
      status: RESULT_STATUS_CODE.rested,
    });
    const mapped = placedToResult(placed, UNITS, 6);
    expect(mapped.status).toBe("open");
    expect(mapped.remainingSize).toBe("0.500000");
    expect(mapped.orderId).toBe("42");
  });

  it("maps a partial fill with a resting remainder to partiallyFilled", () => {
    const placed = placedResult({
      filled: 300n,
      rested: 700n,
      orderSeq: 7n,
      status: RESULT_STATUS_CODE.rested,
    });
    const mapped = placedToResult(placed, UNITS, 6);
    expect(mapped.status).toBe("partiallyFilled");
    expect(mapped.filledSize).toBe("0.300000");
    expect(mapped.remainingSize).toBe("0.700000");
  });

  it("maps a remainder cancelled by the book-full outcome, with a plain reason", () => {
    const placed = placedResult({
      filled: 0n,
      cancelled: 1_000n,
      status: RESULT_STATUS_CODE.remainderCancelledBookFull,
    });
    const mapped = placedToResult(placed, UNITS, 6);
    expect(mapped.status).toBe("cancelled");
    expect(mapped.reason).toMatch(/book is full/);
  });

  it("names the missing buyers and the next step when a sell fills nothing", () => {
    const placed = placedResult({
      cancelled: 1_000n,
      status: RESULT_STATUS_CODE.remainderCancelled,
    });
    const mapped = placedToResult(placed, UNITS, 6, undefined, { side: "sell" });
    expect(mapped.status).toBe("cancelled");
    expect(mapped.reason).toBe(
      "No buyers at your price right now, so nothing filled and nothing was charged. The market maker may be refreshing its quotes. Try again in a few seconds.",
    );
  });

  it("names the missing sellers when a buy fills nothing", () => {
    const placed = placedResult({
      cancelled: 1_000n,
      status: RESULT_STATUS_CODE.remainderCancelled,
    });
    const mapped = placedToResult(placed, UNITS, 6, undefined, { side: "buy" });
    expect(mapped.reason).toMatch(/^No sellers at your price right now/);
  });

  it("does not name a side it does not know", () => {
    const placed = placedResult({
      cancelled: 1_000n,
      status: RESULT_STATUS_CODE.remainderCancelled,
    });
    expect(placedToResult(placed, UNITS, 6).reason).toMatch(/^No orders at your price/);
  });

  it("words a partly filled order's cancelled remainder by side", () => {
    const placed = placedResult({
      filled: 400n,
      cancelled: 600n,
      status: RESULT_STATUS_CODE.remainderCancelled,
    });
    const mapped = placedToResult(placed, UNITS, 6, undefined, { side: "sell" });
    expect(mapped.status).toBe("partiallyFilled");
    expect(mapped.reason).toBe("Part filled; the rest found no buyers and was cancelled.");
  });

  it("describes a fill-time check failure as margin or a market limit, not margin alone", () => {
    const placed = placedResult({
      cancelled: 1_000n,
      status: RESULT_STATUS_CODE.remainderCancelledFillCheck,
    });
    const mapped = placedToResult(placed, UNITS, 6);
    expect(mapped.status).toBe("cancelled");
    expect(mapped.reason).toBe(
      "Nothing filled. The rest was cancelled: it failed a check at fill time (margin or a market limit).",
    );
  });

  it.each([
    [77, /too far from the market, so trading is paused for safety/],
    [37, /too far from the market price/],
    [24, /fall below the margin/],
    [43, /only shrink your position/],
    [48, /position limit/],
  ])("gives a refused result with code %i its own plain sentence", (code, sentence) => {
    const mapped = placedToResult(
      placedResult({ status: RESULT_STATUS_CODE.refused, code }),
      UNITS,
      6,
    );
    expect(mapped.status).toBe("rejected");
    expect(mapped.reason).toMatch(sentence);
    expect(mapped.reason).not.toMatch(/code \d/);
  });

  it("maps a post-only refusal to rejected with a human reason, never a fill", () => {
    const placed = placedResult({ status: RESULT_STATUS_CODE.refusedPostOnlyWouldMatch });
    const mapped = placedToResult(placed, UNITS, 6);
    expect(mapped.status).toBe("rejected");
    expect(mapped.filledSize).toBe("0.000000");
    expect(mapped.reason).toMatch(/post-only/);
  });

  it("maps a generic venue refusal to rejected, naming the code", () => {
    const placed = placedResult({ status: RESULT_STATUS_CODE.refused, code: 3 });
    const mapped = placedToResult(placed, UNITS, 6);
    expect(mapped.status).toBe("rejected");
    expect(mapped.reason).toContain("code 3");
  });

  it("maps an expired (never confirmed) order to rejected, not placed, carrying only sentAt", () => {
    const placed: Placed = {
      outcome: "expired",
      clientOrderId: 9n,
      secret: new Uint8Array(16),
      view: FAKE_VIEW,
      sentAt: 50,
    };
    const mapped = placedToResult(placed, UNITS, 6);
    expect(mapped.status).toBe("rejected");
    expect(mapped.orderId).toBe("");
    expect(mapped.reason).toMatch(/Expired/);
    expect(mapped.reason).toMatch(/not placed/);
    expect(mapped.sentAtMs).toBe(50);
    expect(mapped.resultAtMs).toBeUndefined();
  });
});

describe("thrownToResult: OrderInvalid and TransactionFailed map to the rejected state", () => {
  it("maps OrderInvalid(SizeTooSmall) to a human sentence", () => {
    const mapped = thrownToResult(new OrderInvalid("SizeTooSmall"));
    expect(mapped?.status).toBe("rejected");
    expect(mapped?.reason).toMatch(/minimum size/);
  });

  it("maps OrderInvalid(PriceOffTick) to a human sentence", () => {
    const mapped = thrownToResult(new OrderInvalid("PriceOffTick"));
    expect(mapped?.reason).toMatch(/tick/);
  });

  it("maps OrderInvalid(NotionalTooSmall) to a human sentence", () => {
    const mapped = thrownToResult(new OrderInvalid("NotionalTooSmall"));
    expect(mapped?.reason).toMatch(/notional/);
  });

  it("maps TransactionFailed with a program error code", () => {
    const mapped = thrownToResult(new TransactionFailed("sig", { InstructionError: [0, {}] }));
    expect(mapped?.status).toBe("rejected");
    expect(mapped?.reason).toMatch(/Refused by the venue/);
  });

  const failedWith = (code: number) =>
    new TransactionFailed("sig", { InstructionError: [0, { Custom: code }] });

  it.each([
    [6133, /after its time limit/],
    [6077, /paused for safety/],
    [6048, /position limit/],
    [6043, /only shrink your position/],
    [6037, /too far from the market price/],
    [6024, /fall below the margin/],
    [6090, /blocked/],
    [6091, /listed makers/],
    [6092, /listed takers/],
    [6081, /USDC price guard/],
    [6032, /only takes orders that shrink a position/],
    [6031, /market is paused/],
    [6030, /venue is paused/],
  ])("gives program error %i its own plain sentence", (code, sentence) => {
    const reason = thrownToResult(failedWith(code))?.reason ?? "";
    expect(reason).toMatch(sentence);
    expect(reason).not.toMatch(/program error/);
  });

  it("names a thrown code below 6000 by its number only: it may be another program's", () => {
    const reason = thrownToResult(failedWith(38), { maxPriceAgeSeconds: 90 })?.reason ?? "";
    expect(reason).toMatch(/program error 38\b/);
    expect(reason).not.toMatch(/price/);
  });

  it("suggests Reduce only on a reduce-only perpetual market", () => {
    const reason = thrownToResult(failedWith(6032), { isPerp: true })?.reason ?? "";
    expect(reason).toMatch(/Use Reduce only/);
  });

  it("does not suggest Reduce only on a spot market, which refuses it", () => {
    const reason = thrownToResult(failedWith(6032), { isPerp: false })?.reason ?? "";
    expect(reason).toMatch(/only takes orders that shrink a position/);
    expect(reason).not.toMatch(/Reduce only/);
  });

  it("names the market's own price age limit on a stale-price refusal when it is known", () => {
    const reason = thrownToResult(failedWith(6038), { maxPriceAgeSeconds: 90 })?.reason ?? "";
    expect(reason).toMatch(/this market accepts prices up to 90 seconds old/);
    expect(reason).not.toMatch(/10s/);
  });

  it("does not blame the order's own market alone for a stale price: a position's market can be the stale one", () => {
    const reason = thrownToResult(failedWith(6038), { maxPriceAgeSeconds: 90 })?.reason ?? "";
    expect(reason).toMatch(/another market where this account holds a position/);
  });

  it("says the price is too old without a number when the market's limit is not known", () => {
    const reason = thrownToResult(failedWith(6038))?.reason ?? "";
    expect(reason).toMatch(/price this order is checked against is too old/);
    expect(reason).not.toMatch(/\d+ seconds/);
  });

  it("names the market's own limit on its price-too-old refusal", () => {
    const reason = thrownToResult(failedWith(6079), { maxPriceAgeSeconds: 90 })?.reason ?? "";
    expect(reason).toMatch(/older than the 90 seconds this market accepts/);
  });

  it("reads a stale-price refusal from the result ring the same way", () => {
    const placed = placedResult({ status: RESULT_STATUS_CODE.refused, code: 38 });
    expect(placedToResult(placed, UNITS, 6, undefined, { maxPriceAgeSeconds: 90 }).reason).toMatch(
      /90 seconds/,
    );
  });

  it("keeps the program error number for a refusal it has no sentence for", () => {
    expect(thrownToResult(failedWith(6022))?.reason).toMatch(/program error 6022/);
  });

  it("returns null for an ordinary error, letting the caller's own handling take over", () => {
    expect(thrownToResult(new Error("network down"))).toBeNull();
  });
});

describe("cancelToResult", () => {
  it("reports the cancelled count from a result", () => {
    expect(
      cancelToResult({ ...result({ cancelled: 3n, kind: 3 }), sentAt: 0, resultAt: 1 }),
    ).toEqual({
      cancelled: 3,
    });
  });
});

describe("cancelErrorToResult: OutcomeUnknown and all-slots-busy (0.3.1)", () => {
  it("maps OutcomeUnknown to a pending result that settles to the real count once known", async () => {
    const settled = Promise.resolve({
      ...result({ cancelled: 2n, kind: 3 }),
      sentAt: 0,
      resultAt: 1,
    });
    const mapped = cancelErrorToResult(new OutcomeUnknown(1n, settled), Date.now() + 5_000);
    expect(mapped?.cancelled).toBe(0);
    expect(mapped?.pending).toBeDefined();
    expect((await mapped!.pending!.settled).cancelled).toBe(2);
  });

  it("maps OutcomeUnknown settling to null (expired, never ran) to a plain zero", async () => {
    const mapped = cancelErrorToResult(new OutcomeUnknown(1n, Promise.resolve(null)), Date.now());
    const settled = await mapped!.pending!.settled;
    expect(settled.cancelled).toBe(0);
    expect(settled.reason).toMatch(/Expired, not run/);
  });

  it("maps every order-key slot busy to an immediate zero with a plain reason", () => {
    const mapped = cancelErrorToResult(new Error("every order key is in use"), Date.now());
    expect(mapped?.pending).toBeUndefined();
    expect(mapped?.cancelled).toBe(0);
    expect(mapped?.reason).toMatch(/slots are busy/);
  });

  it("returns null for an ordinary error, letting the caller's own handling take over", () => {
    expect(cancelErrorToResult(new Error("network down"), Date.now())).toBeNull();
  });
});
