import { describe, expect, it } from "vitest";
import { createLatestReads } from "@/lib/trading/latestRead";
import { recheckOffer } from "@/lib/trading/openCopy";
import { tradeGate } from "@/lib/trading/uiRules";

describe("createLatestReads", () => {
  it("drops a read that finishes after a newer one for the same owner started", () => {
    const reads = createLatestReads();
    const older = reads.begin("owner-a");
    const newer = reads.begin("owner-a");
    expect(reads.isCurrent("owner-a", older, "owner-a")).toBe(false);
    expect(reads.isCurrent("owner-a", newer, "owner-a")).toBe(true);
  });

  it("drops an answer for an owner who is no longer the current one", () => {
    const reads = createLatestReads();
    const ticket = reads.begin("owner-a");
    expect(reads.isCurrent("owner-a", ticket, "owner-b")).toBe(false);
    expect(reads.isCurrent("owner-a", ticket, null)).toBe(false);
  });

  it("keeps owners apart", () => {
    const reads = createLatestReads();
    const a = reads.begin("owner-a");
    reads.begin("owner-b");
    expect(reads.isCurrent("owner-a", a, "owner-a")).toBe(true);
  });
});

describe("an account that was never read successfully", () => {
  const ready = { stage: "ready", seedPersisted: true } as const;

  it("keeps Place closed and offers Check again, whatever else is known", () => {
    expect(tradeGate(true, "unknown", ready)).toBe("accountUnknown");
    expect(tradeGate(true, "unknown", null)).toBe("accountUnknown");
    expect(recheckOffer("unknown", ready)).toBe("check");
  });
});
