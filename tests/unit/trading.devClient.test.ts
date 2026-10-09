import { describe, expect, it, vi } from "vitest";
import { DevTradingClient, TradingRequestError } from "@/lib/trading/devClient";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const WALLET = { address: "TraderAddress111111111111111111111111111" };

describe("DevTradingClient.fund", () => {
  it("posts to /v1/fund and returns the parsed grant", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ amount: "5000.000000", reference: "ref-1" }));
    const client = new DevTradingClient({ baseUrl: "http://sim.test", fetchFn });
    const result = await client.fund(WALLET);
    expect(result).toEqual({ kind: "granted", amount: "5000.000000", reference: "ref-1" });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("http://sim.test/v1/fund");
    expect(JSON.parse(init.body)).toEqual({ address: WALLET.address });
  });

  it("reports a 409 as already funded, not a generic error", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: "this address already received its fund grant" }, 409),
      );
    const client = new DevTradingClient({ baseUrl: "http://sim.test", fetchFn });
    expect(await client.fund(WALLET)).toEqual({ kind: "alreadyFunded" });
  });

  it("reports a 429 as rate limited", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ error: "too many fund grants" }, 429));
    const client = new DevTradingClient({ baseUrl: "http://sim.test", fetchFn });
    expect(await client.fund(WALLET)).toEqual({ kind: "rateLimited" });
  });
});

describe("DevTradingClient.placeOrder", () => {
  it("sends the full order body (every order type needs a price) and parses the ack", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        orderId: "ord-1",
        tag: "123456789",
        status: "filled",
        filledSize: "1.000000",
        remainingSize: "0.000000",
        reason: null,
      }),
    );
    const client = new DevTradingClient({ baseUrl: "http://sim.test", fetchFn });
    const result = await client.placeOrder(WALLET, {
      market: "NSOL-PERP",
      side: "buy",
      type: "market",
      price: "151.00",
      size: "1.0",
    });
    expect(result.status).toBe("filled");
    expect(result.tag).toBe("123456789");
    const [, init] = fetchFn.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.price).toBe("151.00");
    expect(body.type).toBe("market");
    expect(body.size).toBe("1.0");
  });
});

describe("DevTradingClient.cancelAllInMarket", () => {
  it("cancels through the only cancel route the venue has", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ cancelled: 1 }));
    const client = new DevTradingClient({ baseUrl: "http://sim.test", fetchFn });
    const result = await client.cancelAllInMarket(WALLET, "NSOL-NUSD");
    expect(result).toEqual({ cancelled: 1 });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("http://sim.test/v1/dev/cancel-all");
    expect(JSON.parse(init.body)).toEqual({ address: WALLET.address, market: "NSOL-NUSD" });
  });
});

describe("DevTradingClient.fetchState", () => {
  it("GETs the trader address and maps balances, positions and open orders", async () => {
    const wire = {
      trader: WALLET.address,
      equity: "5000.000000",
      balances: { nUSD: { balance: "4000.000000", locked: "1000.000000" } },
      positions: { "NSOL-PERP": { size: "1.000000", entryPrice: "150.000000" } },
      openOrders: [],
    };
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(wire));
    const client = new DevTradingClient({ baseUrl: "http://sim.test", fetchFn });
    const result = await client.fetchState(WALLET);
    expect(result.equity).toBe("5000.000000");
    expect(result.balances.nUSD).toEqual({
      asset: "nUSD",
      available: "4000.000000",
      reserved: "1000.000000",
      total: "5000.000000",
    });
    expect(result.positions["NSOL-PERP"]).toEqual({
      market: "NSOL-PERP",
      size: "1.000000",
      entryPrice: "150.000000",
    });
    const [url] = fetchFn.mock.calls[0];
    expect(url).toBe(`http://sim.test/v1/dev/trader?address=${WALLET.address}`);
  });
});

describe("DevTradingClient.subscribe", () => {
  it("polls fetchState immediately and on every interval tick, until unsubscribed", async () => {
    vi.useFakeTimers();
    const wire = {
      trader: WALLET.address,
      equity: "0",
      balances: {},
      positions: {},
      openOrders: [],
    };
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(wire));
    const client = new DevTradingClient({
      baseUrl: "http://sim.test",
      fetchFn,
      pollIntervalMs: 1000,
    });
    const listener = vi.fn();
    const unsubscribe = client.subscribe(WALLET, listener);

    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    await vi.advanceTimersByTimeAsync(5000);
    expect(listener).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe("DevTradingClient error handling", () => {
  it("throws a TradingRequestError on a non-ok response from a non-fund route", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    const client = new DevTradingClient({ baseUrl: "http://sim.test", fetchFn });
    await expect(client.fetchState(WALLET)).rejects.toBeInstanceOf(TradingRequestError);
  });
});
