import { describe, expect, it } from "vitest";
import { marketDisplayName } from "@/lib/market-data/displayName";

describe("marketDisplayName", () => {
  it("drops the leading N of the venue's market ids", () => {
    expect(marketDisplayName("NSOL-PERP")).toBe("SOL-PERP");
    expect(marketDisplayName("NNVDA-PERP")).toBe("NVDA-PERP");
    expect(marketDisplayName("NSOL-NUSD")).toBe("SOL-NUSD");
  });

  it("leaves other ids alone", () => {
    expect(marketDisplayName("SOL-PERP")).toBe("SOL-PERP");
    expect(marketDisplayName("NEAR-PERP")).toBe("NEAR-PERP");
    expect(marketDisplayName("")).toBe("");
  });
});
