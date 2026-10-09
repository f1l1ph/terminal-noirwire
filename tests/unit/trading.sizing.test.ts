import { describe, expect, it } from "vitest";
import { maxOrderSize } from "@/lib/trading/sizing";

describe("maxOrderSize", () => {
  it("bounds a perp buy by margin and fee against free balance, at the chosen leverage", () => {
    const max = maxOrderSize({
      mode: "perp",
      side: "buy",
      price: "100",
      lotSize: "0.1",
      leverage: 10,
      availableQuote: "1000",
    });
    // margin+fee per unit at 10x ~= 100/10 + 100*0.0005 = 10.05; 1000/10.05 ~= 99.5, rounded to lot.
    expect(Number(max)).toBeGreaterThan(90);
    expect(Number(max)).toBeLessThan(100);
    expect(Math.round(Number(max) * 10) / 10).toBeCloseTo(Number(max), 6);
  });

  it("shrinks the max size as leverage drops", () => {
    const high = Number(
      maxOrderSize({
        mode: "perp",
        side: "buy",
        price: "100",
        lotSize: "0.1",
        leverage: 10,
        availableQuote: "1000",
      }),
    );
    const low = Number(
      maxOrderSize({
        mode: "perp",
        side: "buy",
        price: "100",
        lotSize: "0.1",
        leverage: 1,
        availableQuote: "1000",
      }),
    );
    expect(low).toBeLessThan(high);
  });

  it("bounds a spot sell by the owned base asset, not by quote balance", () => {
    const max = maxOrderSize({
      mode: "spot",
      side: "sell",
      price: "100",
      lotSize: "0.01",
      leverage: 1,
      availableQuote: "0",
      availableBase: "2.5",
    });
    expect(Number(max)).toBe(2.5);
  });

  it("caps a reduce-only order at the open position size, ignoring free balance entirely", () => {
    const max = maxOrderSize({
      mode: "perp",
      side: "sell",
      price: "100",
      lotSize: "0.1",
      leverage: 10,
      availableQuote: "0",
      reduceOnlyMax: "0.37",
    });
    expect(Number(max)).toBeCloseTo(0.3, 6);
  });
});
