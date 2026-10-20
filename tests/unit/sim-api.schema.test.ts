import { describe, expect, it } from "vitest";
import { tapeResponseSchema, wsMessageSchema } from "@/lib/sim-api/schema";

const row = (sequence: number) => ({
  market: "NSOL-PERP",
  price: "150",
  size: "1",
  takerSide: "buy",
  takerTag: "1",
  makerTag: "2",
  timestampMs: 0,
  sequence,
});

describe("tape rows from the service", () => {
  it("drops a row whose sequence is not a whole number, keeping the rest of the tape", () => {
    const parsed = tapeResponseSchema.parse({
      network: "devnet",
      simulated: false,
      fills: [row(1), row(1.5), row(-1), row(2)],
    });
    expect(parsed.fills.map((fill) => fill.sequence)).toEqual([1, 2]);
  });

  it("refuses a streamed fill whose sequence is not a whole number", () => {
    expect(wsMessageSchema.safeParse({ type: "fill", ...row(1.5) }).success).toBe(false);
    expect(wsMessageSchema.safeParse({ type: "fill", ...row(3) }).success).toBe(true);
  });
});
