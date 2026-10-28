import { describe, expect, it } from "vitest";
import {
  EXPIRY_READ_EVERY_MS,
  expiringOrders,
  ordersPastExpiry,
  shouldReadRollupClock,
} from "@/lib/trading/expiredOrders";
import type { OpenOrder } from "@/lib/trading/types";

function order(orderId: string, expiresAtMs: number | null | undefined): OpenOrder {
  return {
    orderId,
    tag: "",
    market: "NSOL-PERP",
    side: "buy",
    type: "limit",
    price: "149.00",
    size: "1",
    remainingSize: "1",
    reduceOnly: false,
    expiresAtMs,
  };
}

describe("ordersPastExpiry", () => {
  it("keeps only the orders the rollup's clock is strictly past", () => {
    const orders = [order("1", 1_000), order("2", 2_000), order("3", 3_000)];
    expect(ordersPastExpiry(orders, 2_000).map((o) => o.orderId)).toEqual(["1"]);
    expect(ordersPastExpiry(orders, 2_001).map((o) => o.orderId)).toEqual(["1", "2"]);
  });

  it("never picks an order that does not expire or has no expiry reported", () => {
    expect(ordersPastExpiry([order("1", null), order("2", undefined)], 9e15)).toEqual([]);
  });

  it("picks nothing for a live order when the fresh rollup reading is behind the estimate", () => {
    const live = order("1", 1_060_000);
    expect(ordersPastExpiry([live], 1_000_000)).toEqual([]);
  });
});

describe("expiringOrders", () => {
  it("keeps the orders with a finite expiry, whether or not they look expired", () => {
    const orders = [order("1", 1_000), order("2", null), order("3", undefined), order("4", NaN)];
    expect(expiringOrders(orders).map((o) => o.orderId)).toEqual(["1"]);
  });
});

describe("shouldReadRollupClock", () => {
  const base = { estimateFlagsExpired: false, lastReadMs: 1_000_000 };

  it("reads at once when the estimate says an order has expired", () => {
    expect(shouldReadRollupClock({ ...base, estimateFlagsExpired: true, nowMs: 1_000_001 })).toBe(
      true,
    );
  });

  it("reads without the estimate flagging anything, but at most every 30 seconds", () => {
    expect(EXPIRY_READ_EVERY_MS).toBe(30_000);
    expect(shouldReadRollupClock({ ...base, nowMs: 1_000_000 + 29_999 })).toBe(false);
    expect(shouldReadRollupClock({ ...base, nowMs: 1_000_000 + 30_000 })).toBe(true);
  });

  it("reads when the device clock moved backward past the last reading", () => {
    expect(shouldReadRollupClock({ ...base, nowMs: 1_000_000 - 3_600_000 })).toBe(true);
  });
});
