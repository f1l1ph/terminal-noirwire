import { describe, expect, it } from "vitest";
import {
  offersSpotTrading,
  offersTestFunds,
  placeLabel,
  sideWord,
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

const keys = (stage: "settling" | "installing" | "ready"): OrderKeyState =>
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

  it("fails closed when the account or the keys are not known", () => {
    expect(tradeGate(true, "unknown", null)).toBe("accountUnknown");
    expect(tradeGate(true, "unknown", keys("ready"))).toBe("accountUnknown");
    expect(tradeGate(true, "open", null)).toBe("keysNotReady");
  });

  it("keeps Place closed when key setup failed", () => {
    expect(tradeGate(true, "open", { stage: "failed", reason: "x", seedPersisted: true })).toBe(
      "keysFailed",
    );
  });

  it("opens the gate for exactly one combination: open account, ready keys", () => {
    const statuses = ["unknown", "absent", "open"] as const;
    const states = [null, keys("settling"), keys("installing"), keys("ready")];
    const open = statuses.flatMap((status) =>
      states.filter((state) => tradeGate(true, status, state) === null).map(() => status),
    );
    expect(open).toEqual(["open"]);
  });

  it("never gates a test build", () => {
    expect(tradeGate(false, "absent", keys("settling"))).toBeNull();
  });
});

describe("sideWord", () => {
  it("reads Long and Short on a perpetual", () => {
    expect(sideWord(true, "buy")).toBe("Long");
    expect(sideWord(true, "sell")).toBe("Short");
  });

  it("reads Buy and Sell on spot", () => {
    expect(sideWord(false, "buy")).toBe("Buy");
    expect(sideWord(false, "sell")).toBe("Sell");
  });
});
