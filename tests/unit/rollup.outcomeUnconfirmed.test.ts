import { describe, expect, it } from "vitest";
import {
  cancelErrorToResult,
  placedToResult,
  placeUnknownToResult,
  transferErrorToResult,
  UNCONFIRMED_OUTCOME_REASON,
} from "@/lib/rollup/outcome";
import { OutcomeUnknown, type Placed, type Settled } from "@/lib/rollup/sdk";
import { marketUnitsFromLotSize } from "@/lib/rollup/units";

const UNITS = marketUnitsFromLotSize("0.001000");
const overflow = () => Promise.reject(new Error("results ring overflowed"));

describe("a settlement that rejects ends in a visible outcome", () => {
  it("says what it could not confirm and what to check, and that nothing is resent", () => {
    expect(UNCONFIRMED_OUTCOME_REASON).toMatch(/could not confirm/);
    expect(UNCONFIRMED_OUTCOME_REASON).toMatch(/positions and open orders/);
    expect(UNCONFIRMED_OUTCOME_REASON).toMatch(/Nothing will be sent again automatically/);
  });

  it("settles a placeOrder that came back unknown to a rejected result", async () => {
    const placed = {
      outcome: "unknown",
      clientOrderId: 1n,
      secret: new Uint8Array(16),
      sentAt: 0,
      settled: overflow() as Promise<Settled>,
    } as Placed;
    const mapped = placedToResult(placed, UNITS, 3, Date.now() + 5_000);
    expect(mapped.pending).toBeDefined();
    const settled = await mapped.pending!.settled;
    expect(settled.status).toBe("rejected");
    expect(settled.reason).toBe(UNCONFIRMED_OUTCOME_REASON);
  });

  it("settles a placeOrder that threw OutcomeUnknown to a rejected result", async () => {
    const mapped = placeUnknownToResult(
      new OutcomeUnknown(1n, overflow(), new Error("socket hang up")),
      UNITS,
      3,
      Date.now() + 5_000,
    );
    const settled = await mapped!.pending!.settled;
    expect(settled.status).toBe("rejected");
    expect(settled.reason).toBe(UNCONFIRMED_OUTCOME_REASON);
  });

  it("settles a cancel to zero cancelled with the reason", async () => {
    const mapped = cancelErrorToResult(new OutcomeUnknown(1n, overflow()), Date.now() + 5_000);
    expect(await mapped!.pending!.settled).toEqual({
      cancelled: 0,
      reason: UNCONFIRMED_OUTCOME_REASON,
    });
  });

  it("settles a transfer to an error with the reason", async () => {
    const mapped = transferErrorToResult(new OutcomeUnknown(1n, overflow()), Date.now() + 5_000);
    expect(mapped).toMatchObject({ kind: "pending" });
    const settled = await (mapped as { pending: { settled: Promise<unknown> } }).pending.settled;
    expect(settled).toEqual({ kind: "error", message: UNCONFIRMED_OUTCOME_REASON });
  });
});
