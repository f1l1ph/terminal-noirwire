import { describe, expect, it } from "vitest";
import { cancelToResult, placedToResult, thrownToResult } from "@/lib/rollup/outcome";
import {
  OrderInvalid,
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
    expect(mapped.reason).toMatch(/expired/);
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

  it("reports zero, not an error, when the instruction's outcome is unknown (expired)", () => {
    expect(cancelToResult(null)).toEqual({ cancelled: 0 });
  });
});
