import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/reference-history/route";

const UPSTREAM_ROWS = [
  [1_700_000_300, 100, 102, 101, 101.5, 12],
  [1_700_000_000, 99, 101, 100, 100.5, 8],
];

function request(query: string): Request {
  return new Request(`https://terminal.example/api/reference-history${query}`);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("GET /api/reference-history", () => {
  it("rejects a missing or unknown range with 400 and never calls upstream", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    for (const query of ["", "?range=5Y", "?range=1d", "?range="]) {
      const response = await GET(request(query));
      expect(response.status).toBe(400);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("returns only validated, ascending candles with the cache headers", async () => {
    vi.useFakeTimers({ now: 1_700_000_400_000, toFake: ["Date"] });
    const upstream = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(UPSTREAM_ROWS)));
    vi.stubGlobal("fetch", upstream);
    const response = await GET(request("?range=1D"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "public, s-maxage=60, stale-while-revalidate=120",
    );
    expect(await response.json()).toEqual({
      candles: [
        { time: 1_700_000_000, open: 100, high: 101, low: 99, close: 100.5 },
        { time: 1_700_000_300, open: 101, high: 102, low: 100, close: 101.5 },
      ],
    });
    expect(String(upstream.mock.calls[0]?.[0])).toContain(
      "https://api.exchange.coinbase.com/products/SOL-USD/candles?granularity=300",
    );
  });

  it("answers 502 with a small error when upstream fails, echoing nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("secret upstream detail", { status: 500 })),
    );
    const down = await GET(request("?range=1H"));
    expect(down.status).toBe(502);
    expect(await down.json()).toEqual({ error: "reference history unavailable" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network");
      }),
    );
    expect((await GET(request("?range=1H"))).status).toBe(502);
  });

  it("answers 502 when upstream returns future-dated or far-past candles", async () => {
    vi.useFakeTimers({ now: 1_700_000_400_000, toFake: ["Date"] });
    for (const rows of [
      [
        [1_700_100_300, 100, 102, 101, 101.5, 12],
        [1_700_100_000, 99, 101, 100, 100.5, 8],
      ],
      [
        [1_600_000_300, 100, 102, 101, 101.5, 12],
        [1_600_000_000, 99, 101, 100, 100.5, 8],
      ],
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify(rows))),
      );
      expect((await GET(request("?range=1D"))).status).toBe(502);
    }
  });

  it("answers 502 when upstream returns a malformed body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([[1, 2, 3]]))),
    );
    expect((await GET(request("?range=1W"))).status).toBe(502);
  });
});
