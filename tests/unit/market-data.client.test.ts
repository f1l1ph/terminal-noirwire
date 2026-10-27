import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchMarkets,
  isServiceUnreachable,
  MarketDataRequestError,
  REQUEST_TIMEOUT_MS,
} from "@/lib/market-data/client";

afterEach(() => vi.unstubAllGlobals());

describe("market data requests", () => {
  it("gives every request a timeout signal", async () => {
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      signal = init?.signal;
      return new Response(JSON.stringify({ markets: [] }), { status: 200 });
    });
    await fetchMarkets("https://sim.example").catch(() => {});
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(REQUEST_TIMEOUT_MS).toBe(8_000);
  });

  it("counts a request that times out as the service being unreachable", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    const error = await fetchMarkets("https://sim.example").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MarketDataRequestError);
    expect(isServiceUnreachable(error)).toBe(true);
  });
});
