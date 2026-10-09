import { describe, expect, it, vi } from "vitest";
import { DevTradingClient, TradingRequestError } from "@/lib/trading/devClient";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

const WALLET = { address: "TraderAddress111111111111111111111111111" };

describe("DevTradingClient.fund", () => {
  it("posts to /v1/fund and returns the parsed amount and reference", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ amount: "5000", reference: "ref-1" }));
    const client = new DevTradingClient({ baseUrl: "http://sim.test", fetchFn });
    const result = await client.fund(WALLET);
    expect(result).toEqual({ amount: "5000", reference: "ref-1" });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("http://sim.test/v1/fund");
    expect(JSON.parse(init.body)).toEqual({ address: WALLET.address });
  });

  it("throws a TradingRequestError on a non-ok response", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({}, false, 429));
    const client = new DevTradingClient({ baseUrl: "http://sim.test", fetchFn });
    await expect(client.fund(WALLET)).rejects.toBeInstanceOf(TradingRequestError);
  });
});

describe("DevTradingClient.placeOrder", () => {
  it("sends the full order body including the client tag, and parses the ack", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        orderId: "order-1",
        clientOrderId: "client-1",
        status: "accepted",
        confirmedAt: 1234,
      }),
    );
    const client = new DevTradingClient({ baseUrl: "http://sim.test", fetchFn });
    const result = await client.placeOrder(WALLET, {
      market: "NSOL-PERP",
      side: "buy",
      orderType: "market",
      quantity: "1.0",
      protectionPrice: "151.00",
      leverage: 5,
      clientOrderId: "client-1",
      clientTag: "abc123",
    });
    expect(result.status).toBe("accepted");
    const [, init] = fetchFn.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.clientTag).toBe("abc123");
    expect(body.leverage).toBe(5);
    expect(body.quantity).toBe("1.0");
  });
});

describe("DevTradingClient.cancelOrder", () => {
  it("cancels through the cancel-all route, since no per-order route is documented", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ cancelled: 1 }));
    const client = new DevTradingClient({ baseUrl: "http://sim.test", fetchFn });
    const result = await client.cancelOrder(WALLET, "NSOL-NUSD", "order-9");
    expect(result).toEqual({ cancelled: 1 });
    const [url] = fetchFn.mock.calls[0];
    expect(url).toBe("http://sim.test/v1/dev/cancel-all");
  });
});

describe("DevTradingClient.fetchState", () => {
  it("GETs the trader address and parses balances, positions, open orders and fills", async () => {
    const state = {
      balances: [{ asset: "nUSD", total: "5000", available: "4000" }],
      positions: [],
      openOrders: [],
      ownFills: [],
    };
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(state));
    const client = new DevTradingClient({ baseUrl: "http://sim.test", fetchFn });
    const result = await client.fetchState(WALLET);
    expect(result).toEqual(state);
    const [url] = fetchFn.mock.calls[0];
    expect(url).toBe(`http://sim.test/v1/dev/trader?address=${WALLET.address}`);
  });
});

describe("DevTradingClient.subscribe", () => {
  it("polls fetchState immediately and on every interval tick, until unsubscribed", async () => {
    vi.useFakeTimers();
    const state = { balances: [], positions: [], openOrders: [], ownFills: [] };
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(state));
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
