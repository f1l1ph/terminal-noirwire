import { describe, expect, it } from "vitest";
import { latencyDisplay } from "@/lib/market-data/selectors";
import type { StatsResponse } from "@/lib/market-data/types";

function stats(overrides: Partial<StatsResponse> = {}): StatsResponse {
  return {
    network: "devnet",
    orders: { user: 40, bot: 60 },
    fills: { user: 20, bot: 60 },
    volume: { user: "1000.000000", bot: "5000.000000" },
    tradersTotal: 5,
    latency: {
      medianMs: 420,
      p99Ms: 910,
      sampleSize: 184,
      measuredFrom: "http:request",
    },
    updatedAtMs: 900_000,
    ...overrides,
  };
}

describe("latencyDisplay", () => {
  it("reports ok with the measured figures when fresh and well sampled", () => {
    const result = latencyDisplay(stats(), 900_500);
    expect(result).toMatchObject({ status: "ok", p50Ms: 420, p99Ms: 910, sampleSize: 184 });
  });

  it("reports insufficient when the sample size is below the threshold", () => {
    const result = latencyDisplay(
      stats({
        latency: { medianMs: 420, p99Ms: 910, sampleSize: 4, measuredFrom: "http:request" },
      }),
      900_500,
    );
    expect(result).toEqual({ status: "insufficient", sampleSize: 4 });
  });

  it("reports unavailable once the reading is stale, never a stale fast label", () => {
    const result = latencyDisplay(stats({ updatedAtMs: 0 }), 900_000);
    expect(result.status).toBe("unavailable");
  });

  it("reports unavailable with no stats at all", () => {
    expect(latencyDisplay(null, 1000)).toEqual({ status: "unavailable", lastValidAt: null });
  });
});
