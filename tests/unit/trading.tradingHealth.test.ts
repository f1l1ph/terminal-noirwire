import { describe, expect, it } from "vitest";
import {
  fetchTradingPause,
  healthPollDelayMs,
  HEALTH_POLL_MS,
  pauseStopsOrder,
  plainHealthReason,
} from "@/lib/trading/tradingHealth";

function answering(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
    })) as unknown as typeof fetch;
}

const BASE = { ok: true, venue: "rollup", network: "mainnet" };

describe("fetchTradingPause", () => {
  it("is null while the market maker has quotes up", async () => {
    const answer = await fetchTradingPause(
      "http://sim.test",
      answering(200, { ...BASE, trading: { ready: true } }),
    );
    expect(answer).toBeNull();
  });

  it("is null when the service reports nothing about trading, as when it is asleep", async () => {
    expect(await fetchTradingPause("http://sim.test", answering(200, BASE))).toBeNull();
  });

  it("is a pause with the service's reason when that reads as plain text", async () => {
    const reason = "NSOL-PERP maker has had no quotes resting for 761 s: its last quotes expired";
    const answer = await fetchTradingPause(
      "http://sim.test",
      answering(200, { ...BASE, trading: { ready: false, reason } }),
    );
    expect(answer).toEqual({ reason });
  });

  it("is a pause without a reason when the reason is not plain text", async () => {
    const answer = await fetchTradingPause(
      "http://sim.test",
      answering(200, { ...BASE, trading: { ready: false, reason: 'Error: {"code":-32000}' } }),
    );
    expect(answer).toEqual({ reason: null });
  });

  it("reads the body of a 503, which the route sends while the service is not fully ready", async () => {
    const answer = await fetchTradingPause(
      "http://sim.test",
      answering(503, { ...BASE, ok: false, trading: { ready: false } }),
    );
    expect(answer).toEqual({ reason: null });
  });

  it("asks the public health route", async () => {
    let asked = "";
    await fetchTradingPause("http://sim.test", (async (input: RequestInfo | URL) => {
      asked = String(input);
      return new Response(JSON.stringify(BASE), { status: 200 });
    }) as unknown as typeof fetch);
    expect(asked).toBe("http://sim.test/v1/health");
  });

  it("throws on another failure status, an unreadable body or an unreachable service", async () => {
    await expect(fetchTradingPause("http://sim.test", answering(500, BASE))).rejects.toThrow();
    await expect(fetchTradingPause("http://sim.test", answering(200, "<html>"))).rejects.toThrow();
    await expect(
      fetchTradingPause("http://sim.test", answering(200, { ok: true })),
    ).rejects.toThrow();
    await expect(
      fetchTradingPause("http://sim.test", (async () => {
        throw new TypeError("network");
      }) as unknown as typeof fetch),
    ).rejects.toThrow();
  });
});

describe("plainHealthReason", () => {
  it("keeps a plain sentence", () => {
    expect(plainHealthReason("maker stopped: daily loss limit reached")).toBe(
      "maker stopped: daily loss limit reached",
    );
  });

  it("drops anything that is empty, long, or carries markup or structure", () => {
    expect(plainHealthReason(undefined)).toBeNull();
    expect(plainHealthReason("   ")).toBeNull();
    expect(plainHealthReason("a".repeat(201))).toBeNull();
    expect(plainHealthReason("<b>stopped</b>")).toBeNull();
    expect(plainHealthReason('{"reason":"stopped"}')).toBeNull();
    expect(plainHealthReason("line one\nline two")).toBeNull();
    expect(plainHealthReason("see `logs` at https://x.test/a?b=c")).toBeNull();
  });
});

describe("pauseStopsOrder", () => {
  it("stops a market or immediate-or-cancel order while paused", () => {
    expect(pauseStopsOrder(true, { canRest: false, reduceOnly: false })).toBe(true);
  });

  it("lets a resting limit through while paused", () => {
    expect(pauseStopsOrder(true, { canRest: true, reduceOnly: false })).toBe(false);
  });

  it("lets a reduce-only order through while paused, market or limit", () => {
    expect(pauseStopsOrder(true, { canRest: false, reduceOnly: true })).toBe(false);
  });

  it("stops nothing when trading is not paused", () => {
    expect(pauseStopsOrder(false, { canRest: false, reduceOnly: false })).toBe(false);
  });
});

describe("healthPollDelayMs", () => {
  it("polls every 15 seconds while the service answers", () => {
    expect(healthPollDelayMs(0)).toBe(HEALTH_POLL_MS);
    expect(HEALTH_POLL_MS).toBe(15_000);
  });

  it("waits longer after each failure in a row, up to two minutes", () => {
    expect([1, 2, 3, 4, 5, 9].map(healthPollDelayMs)).toEqual([
      30_000, 60_000, 120_000, 120_000, 120_000, 120_000,
    ]);
  });
});
