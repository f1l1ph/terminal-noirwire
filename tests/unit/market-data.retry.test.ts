import { describe, expect, it } from "vitest";
import { loadWithRetry } from "@/lib/market-data/retry";
import { MarketDataStore } from "@/lib/market-data/store";

describe("loadWithRetry", () => {
  it("asks again with growing waits until the service answers", async () => {
    let calls = 0;
    const waits: number[] = [];
    let failures = 0;
    const answer = await loadWithRetry(
      async () => {
        calls += 1;
        if (calls < 4) throw new Error("down");
        return "markets";
      },
      {
        isCancelled: () => false,
        onFailure: () => {
          failures += 1;
        },
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    expect(answer).toBe("markets");
    expect(calls).toBe(4);
    expect(failures).toBe(3);
    expect(waits).toEqual([1_000, 2_000, 4_000]);
  });

  it("stops waiting longer at thirty seconds", async () => {
    const waits: number[] = [];
    let calls = 0;
    await loadWithRetry(
      async () => {
        calls += 1;
        if (calls < 9) throw new Error("down");
        return "ok";
      },
      {
        isCancelled: () => false,
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    expect(Math.max(...waits)).toBe(30_000);
  });

  it("gives up after the attempts it was allowed, without a trailing wait", async () => {
    let calls = 0;
    const waits: number[] = [];
    const answer = await loadWithRetry(
      async () => {
        calls += 1;
        throw new Error("down");
      },
      {
        isCancelled: () => false,
        maxAttempts: 3,
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    expect(answer).toBeUndefined();
    expect(calls).toBe(3);
    expect(waits).toHaveLength(2);
  });

  it("stops at once when the caller has gone", async () => {
    let cancelled = false;
    let calls = 0;
    const answer = await loadWithRetry(
      async () => {
        calls += 1;
        cancelled = true;
        throw new Error("down");
      },
      { isCancelled: () => cancelled, sleep: async () => {} },
    );
    expect(answer).toBeUndefined();
    expect(calls).toBe(1);
  });
});

describe("the price service being down", () => {
  it("is flagged while the market list has not loaded, and cleared when it arrives", () => {
    const store = new MarketDataStore();
    expect(store.getState().marketsUnreachable).toBe(false);
    store.setMarketsUnreachable(true);
    expect(store.getState().marketsUnreachable).toBe(true);
    store.setMarkets([]);
    expect(store.getState().marketsUnreachable).toBe(false);
  });
});
