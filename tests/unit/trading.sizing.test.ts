import { describe, expect, it } from "vitest";
import { staleReduceOnlyNotice } from "@/lib/trading/sizing";

describe("staleReduceOnlyNotice", () => {
  it("says the price is old and the close may be refused", () => {
    const text = staleReduceOnlyNotice("2 min");
    expect(text).toContain("The price is 2 min old.");
    expect(text).toContain("may be refused if the market has moved");
    expect(text).not.toContain("—");
  });

  it("still reads plainly with no known age", () => {
    expect(staleReduceOnlyNotice(null)).toMatch(/^The price is too old\./);
  });
});
