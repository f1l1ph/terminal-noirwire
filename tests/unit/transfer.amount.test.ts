import { describe, expect, it } from "vitest";
import { atomsText, balanceAtoms, checkAmount, firstDepositNeeds } from "@/lib/transfer/amount";

const BALANCE = 10_000_000n;

describe("checkAmount", () => {
  it.each([
    ["5", 5_000_000n],
    ["0.25", 250_000n],
    ["0.000001", 1n],
    ["1.000000", 1_000_000n],
    ["10", 10_000_000n],
    [" 2.5 ", 2_500_000n],
  ])("reads %s as %s atoms", (text, atoms) => {
    expect(checkAmount(text, 6, BALANCE)).toEqual({ ok: true, atoms });
  });

  it("accepts exactly the balance and refuses one atom above it", () => {
    expect(checkAmount("10", 6, BALANCE)).toEqual({ ok: true, atoms: BALANCE });
    expect(checkAmount("10.000001", 6, BALANCE)).toEqual({ ok: false, reason: "above-limit" });
  });

  it("refuses more decimal places than the token has", () => {
    expect(checkAmount("0.0000001", 6, BALANCE)).toEqual({
      ok: false,
      reason: "too-many-decimals",
    });
    expect(checkAmount("1.1234567", 6, BALANCE)).toEqual({
      ok: false,
      reason: "too-many-decimals",
    });
  });

  it.each(["0", "0.0", "0.000000", "00"])("refuses the zero amount %s", (text) => {
    expect(checkAmount(text, 6, BALANCE)).toEqual({ ok: false, reason: "zero" });
  });

  it.each(["", "   "])("treats %j as nothing typed", (text) => {
    expect(checkAmount(text, 6, BALANCE)).toEqual({ ok: false, reason: "empty" });
  });

  it.each(["abc", "-1", "+1", "1e3", "1,5", ".5", "5.", "1.2.3", "0x10", "NaN", "Infinity"])(
    "refuses %s",
    (text) => {
      expect(checkAmount(text, 6, BALANCE)).toMatchObject({ ok: false, reason: "invalid" });
    },
  );

  it("never rounds through a float: a 17-digit amount keeps every atom", () => {
    const limit = 9_007_199_254_740_993n * 10n;
    expect(checkAmount("9007199254.740993", 6, limit)).toEqual({
      ok: true,
      atoms: 9_007_199_254_740_993n,
    });
  });

  it("refuses an amount no balance can hold", () => {
    expect(checkAmount("99999999999999999999999", 6, BALANCE)).toMatchObject({ ok: false });
  });

  it("refuses whatever it cannot check against while the limit is unknown", () => {
    expect(checkAmount("1", 6, null)).toEqual({ ok: false, reason: "limit-unknown" });
  });

  it("refuses a zero limit for any amount", () => {
    expect(checkAmount("0.000001", 6, 0n)).toEqual({ ok: false, reason: "above-limit" });
  });
});

describe("balanceAtoms", () => {
  it("rounds down so a limit is never overstated", () => {
    expect(balanceAtoms("1.2345679", 6)).toBe(1_234_567n);
    expect(balanceAtoms("0", 6)).toBe(0n);
    expect(balanceAtoms("12", 6)).toBe(12_000_000n);
  });

  it("gives nothing for text that is not a plain non-negative decimal", () => {
    expect(balanceAtoms("-1", 6)).toBeNull();
    expect(balanceAtoms("", 6)).toBeNull();
    expect(balanceAtoms("1e6", 6)).toBeNull();
  });
});

describe("firstDepositNeeds", () => {
  it.each([
    [10_000_000n, "10"],
    [2_500_000n, "2.5"],
    [100_000_000n, "100"],
    [1n, "0.000001"],
  ])("states a minimum of %s atoms as %s USDC", (atoms, shown) => {
    expect(firstDepositNeeds(atoms, 6)).toBe(
      `Your first deposit opens your trading account: at least ${shown} USDC`,
    );
  });
});

describe("atomsText", () => {
  it("keeps every decimal place", () => {
    expect(atomsText(2_500_000n, 6)).toBe("2.500000");
    expect(atomsText(1n, 6)).toBe("0.000001");
    expect(atomsText(30_000_000n, 9)).toBe("0.030000000");
  });

  it("is read back as the same atoms", () => {
    expect(checkAmount(atomsText(123_456_789n, 6), 6, 10n ** 12n)).toEqual({
      ok: true,
      atoms: 123_456_789n,
    });
  });
});
