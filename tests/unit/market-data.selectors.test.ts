import { describe, expect, it } from "vitest";
import { latencyDisplay } from "@/lib/market-data/selectors";
import type { VenueStats } from "@/lib/market-data/types";

function stats(overrides: Partial<VenueStats> = {}): VenueStats {
  return {
    orders: 100,
    fills: 80,
    volume: "1000",
    traders: 5,
    latency: {
      p50Ms: 420,
      p99Ms: 910,
      sampleCount: 184,
      windowStart: 0,
      windowEnd: 900_000,
      measuredFrom: "order placement to venue confirmation",
    },
    updatedAt: 900_000,
    network: "devnet",
    simulated: true,
    ...overrides,
  };
}

describe("latencyDisplay", () => {
  it("reports ok with the measured figures when fresh and well sampled", () => {
    const result = latencyDisplay(stats(), 900_500);
    expect(result).toMatchObject({ status: "ok", p50Ms: 420, p99Ms: 910, sampleCount: 184 });
  });

  it("reports insufficient when the sample size is below the threshold", () => {
    const result = latencyDisplay(
      stats({
        latency: {
          p50Ms: 420,
          p99Ms: 910,
          sampleCount: 4,
          windowStart: 0,
          windowEnd: 900_000,
          measuredFrom: "order placement to venue confirmation",
        },
      }),
      900_500,
    );
    expect(result).toEqual({ status: "insufficient", sampleCount: 4 });
  });

  it("reports unavailable once the reading is stale, never a stale fast label", () => {
    const result = latencyDisplay(stats({ updatedAt: 0 }), 900_000);
    expect(result.status).toBe("unavailable");
  });

  it("reports unavailable with no stats at all", () => {
    expect(latencyDisplay(null, 1000)).toEqual({ status: "unavailable", lastValidAt: null });
  });
});
