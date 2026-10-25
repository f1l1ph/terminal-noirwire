import { describe, expect, it } from "vitest";
import {
  offersSpotTrading,
  offersTestFunds,
  placeLabel,
  tradeGate,
  walletlessAction,
  walletlessDockText,
} from "@/lib/trading/uiRules";
import type { OrderKeyState } from "@/lib/trading/types";

const TEST_ONLY = /test|faucet|devnet|airdrop/i;

describe("what a mainnet build leaves out", () => {
  it("offers no test funds and no spot trading", () => {
    expect(offersTestFunds(true)).toBe(false);
    expect(offersSpotTrading(true)).toBe(false);
  });

  it("keeps both on a test build", () => {
    expect(offersTestFunds(false)).toBe(true);
    expect(offersSpotTrading(false)).toBe(true);
  });

  it("cannot create a wallet from the order form on mainnet", () => {
    expect(walletlessAction(true).disabled).toBe(true);
    expect(walletlessAction(false).disabled).toBe(false);
  });

  it("carries no test-only wording in any mainnet label", () => {
    const labels = [
      walletlessAction(true).label,
      walletlessDockText(true),
      placeLabel("long", true),
    ];
    for (const label of labels) expect(label).not.toMatch(TEST_ONLY);
  });

  it("still says test on a test build", () => {
    expect(walletlessAction(false).label).toMatch(TEST_ONLY);
    expect(placeLabel("long", false)).toMatch(TEST_ONLY);
  });
});

const keys = (stage: OrderKeyState["stage"]): OrderKeyState =>
  stage === "settling"
    ? { stage, readyAtMs: 1, seedPersisted: true }
    : { stage, seedPersisted: true };

describe("tradeGate", () => {
  it("blocks orders until the account is open, then until the keys are ready", () => {
    expect(tradeGate(true, "absent", keys("ready"))).toBe("needsAccount");
    expect(tradeGate(true, "open", keys("settling"))).toBe("keysNotReady");
    expect(tradeGate(true, "open", keys("installing"))).toBe("keysNotReady");
    expect(tradeGate(true, "open", keys("ready"))).toBeNull();
  });

  it("does not guess when the account or the keys are not known", () => {
    expect(tradeGate(true, "unknown", null)).toBeNull();
    expect(tradeGate(true, "open", null)).toBeNull();
  });

  it("never gates a test build", () => {
    expect(tradeGate(false, "absent", keys("settling"))).toBeNull();
  });
});
