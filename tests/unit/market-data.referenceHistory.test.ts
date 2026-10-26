import { describe, expect, it, vi } from "vitest";
import {
  changePercent,
  fetchReferenceHistory,
  HISTORY_RANGES,
  parseProxyCandles as parseProxyCandlesAt,
  parseReferenceCandles as parseReferenceCandlesAt,
  priceRange,
  RANGE_SPECS,
  rangeStartPrice,
  referenceHistoryUrl,
  type HistoryRange,
} from "@/lib/market-data/reference-history";

const NOW_MS = 1_700_000_400_000;
const parseReferenceCandles = (body: unknown, range: HistoryRange = "1H", nowMs = NOW_MS) =>
  parseReferenceCandlesAt(body, range, nowMs);
const parseProxyCandles = (body: unknown, range: HistoryRange = "1H", nowMs = NOW_MS) =>
  parseProxyCandlesAt(body, range, nowMs);

const NEWEST_FIRST = [
  [1_700_000_300, 100, 102, 101, 101.5, 12],
  [1_700_000_000, 99, 101, 100, 100.5, 8],
];

describe("parseReferenceCandles", () => {
  it("returns ascending candles from the source's newest-first rows", () => {
    expect(parseReferenceCandles(NEWEST_FIRST)).toEqual([
      { time: 1_700_000_000, open: 100, high: 101, low: 99, close: 100.5 },
      { time: 1_700_000_300, open: 101, high: 102, low: 100, close: 101.5 },
    ]);
  });

  it("collapses a duplicated timestamp to one candle", () => {
    const rows = [...NEWEST_FIRST, [1_700_000_300, 100, 102, 101, 101.5, 12]];
    expect(parseReferenceCandles(rows)).toHaveLength(2);
  });

  it("rejects anything that is not an array of at least two candles", () => {
    expect(parseReferenceCandles(null)).toBeNull();
    expect(parseReferenceCandles({ message: "NotFound" })).toBeNull();
    expect(parseReferenceCandles([])).toBeNull();
    expect(parseReferenceCandles([NEWEST_FIRST[0]])).toBeNull();
  });

  it("rejects the whole response when one row is malformed", () => {
    const short = [...NEWEST_FIRST, [1_699_999_700, 99, 101]];
    const text = [...NEWEST_FIRST, ["1699999700", 99, 101, 100, 100.5, 8]];
    const nan = [...NEWEST_FIRST, [1_699_999_700, Number.NaN, 101, 100, 100.5, 8]];
    const negative = [...NEWEST_FIRST, [1_699_999_700, -1, 101, 100, 100.5, 8]];
    const fractionalTime = [...NEWEST_FIRST, [1_699_999_700.5, 99, 101, 100, 100.5, 8]];
    for (const body of [short, text, nan, negative, fractionalTime]) {
      expect(parseReferenceCandles(body)).toBeNull();
    }
  });

  it("rejects a candle whose open or close sits outside its low-high range", () => {
    const outside = [...NEWEST_FIRST, [1_699_999_700, 99, 101, 105, 100, 8]];
    const inverted = [...NEWEST_FIRST, [1_699_999_700, 101, 99, 100, 100, 8]];
    expect(parseReferenceCandles(outside)).toBeNull();
    expect(parseReferenceCandles(inverted)).toBeNull();
  });

  it("rejects an absurd price", () => {
    const body = [...NEWEST_FIRST, [1_699_999_700, 1, 9e9, 5, 5, 8]];
    expect(parseReferenceCandles(body)).toBeNull();
  });

  it("rejects more candles than one request can return", () => {
    const rows = Array.from({ length: 301 }, (_, i) => [1_700_000_000 + i * 60, 1, 2, 1, 2, 0]);
    expect(parseReferenceCandles(rows)).toBeNull();
  });

  it("rejects candles dated after now plus one candle", () => {
    const future = [...NEWEST_FIRST, [1_700_000_400 + 61, 99, 101, 100, 100.5, 8]];
    expect(parseReferenceCandles(future)).toBeNull();
    const edge = [...NEWEST_FIRST, [1_700_000_400 + 60, 99, 101, 100, 100.5, 8]];
    expect(parseReferenceCandles(edge)).toHaveLength(3);
  });

  it("rejects candles from before the range start minus one candle", () => {
    const old = [...NEWEST_FIRST, [1_700_000_400 - 3_600 - 61, 99, 101, 100, 100.5, 8]];
    expect(parseReferenceCandles(old)).toBeNull();
    const farBefore = [...NEWEST_FIRST, [1_000_000_000, 99, 101, 100, 100.5, 8]];
    expect(parseReferenceCandles(farBefore)).toBeNull();
    const edge = [...NEWEST_FIRST, [1_700_000_400 - 3_600 - 60, 99, 101, 100, 100.5, 8]];
    expect(parseReferenceCandles(edge)).toHaveLength(3);
  });

  it("rejects a time beyond the safe integer range", () => {
    const huge = [...NEWEST_FIRST, [2 ** 60, 99, 101, 100, 100.5, 8]];
    expect(parseReferenceCandles(huge)).toBeNull();
  });

  it("measures the window against the requested range", () => {
    const dayOld = [
      [1_700_000_300 - 80_000, 99, 101, 100, 100.5, 8],
      [1_700_000_300, 100, 102, 101, 101.5, 12],
    ];
    expect(parseReferenceCandles(dayOld, "1H")).toBeNull();
    expect(parseReferenceCandles(dayOld, "1D")).toHaveLength(2);
  });
});

describe("referenceHistoryUrl", () => {
  const now = Date.UTC(2026, 9, 26, 12, 0, 0, 500);

  it("asks for the span ending now at the range's candle size", () => {
    const url = new URL(referenceHistoryUrl("1D", now));
    expect(url.origin).toBe("https://api.exchange.coinbase.com");
    expect(url.pathname).toBe("/products/SOL-USD/candles");
    expect(url.searchParams.get("granularity")).toBe("300");
    expect(url.searchParams.get("end")).toBe("2026-10-26T12:00:00.000Z");
    expect(url.searchParams.get("start")).toBe("2026-10-25T12:00:00.000Z");
  });

  it("stays within the source's candle limit and candle sizes for every range", () => {
    const allowed = new Set([60, 300, 900, 3600, 21600, 86400]);
    for (const range of HISTORY_RANGES) {
      const { granularitySec, spanSec } = RANGE_SPECS[range];
      expect(allowed.has(granularitySec)).toBe(true);
      expect(spanSec / granularitySec).toBeLessThanOrEqual(300);
    }
  });
});

const PROXY_BODY = {
  candles: [
    { time: 1_700_000_000, open: 100, high: 101, low: 99, close: 100.5 },
    { time: 1_700_000_300, open: 101, high: 102, low: 100, close: 101.5 },
  ],
};

describe("parseProxyCandles", () => {
  it("accepts the route's own shape", () => {
    expect(parseProxyCandles(PROXY_BODY)).toEqual(PROXY_BODY.candles);
  });

  it("rejects anything else", () => {
    const [a, b] = PROXY_BODY.candles;
    expect(parseProxyCandles(null)).toBeNull();
    expect(parseProxyCandles({})).toBeNull();
    expect(parseProxyCandles({ candles: [a] })).toBeNull();
    expect(parseProxyCandles({ candles: [b, a] })).toBeNull();
    expect(parseProxyCandles({ candles: [a, { ...b, close: "101" }] })).toBeNull();
    expect(parseProxyCandles({ candles: [a, { ...b, high: 90 }] })).toBeNull();
    expect(parseProxyCandles({ candles: [a, { ...b, time: 1.5 }] })).toBeNull();
  });

  it("rejects future-dated and out-of-range candles", () => {
    const [a, b] = PROXY_BODY.candles;
    expect(parseProxyCandles({ candles: [a, { ...b, time: 1_700_000_400 + 61 }] })).toBeNull();
    expect(parseProxyCandles({ candles: [{ ...a, time: 1_000_000_000 }, b] })).toBeNull();
    expect(parseProxyCandles({ candles: [a, { ...b, time: 2 ** 60 }] })).toBeNull();
    expect(parseProxyCandles(PROXY_BODY, "1H", NOW_MS)).toEqual(PROXY_BODY.candles);
  });
});

describe("fetchReferenceHistory", () => {
  it("reads the same-origin route and returns validated candles", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(PROXY_BODY)));
    const candles = await fetchReferenceHistory("1H", undefined, fetchImpl, NOW_MS);
    expect(candles).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("/api/reference-history?range=1H");
  });

  it("throws when the route's candles are dated in the future", async () => {
    const future = {
      candles: PROXY_BODY.candles.map((candle) => ({ ...candle, time: candle.time + 100_000 })),
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(future)));
    await expect(fetchReferenceHistory("1H", undefined, fetchImpl, NOW_MS)).rejects.toThrow();
  });

  it("throws on an HTTP error", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 502 }));
    await expect(fetchReferenceHistory("1H", undefined, fetchImpl)).rejects.toThrow();
  });

  it("throws on a malformed body and on a network failure", async () => {
    const malformed = vi.fn(async () => new Response(JSON.stringify({ candles: [1, 2] })));
    await expect(fetchReferenceHistory("1H", undefined, malformed)).rejects.toThrow();
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(fetchReferenceHistory("1H", undefined, offline)).rejects.toThrow();
  });
});

describe("change helpers", () => {
  it("measures the change from the range's first open", () => {
    const candles = parseReferenceCandles(NEWEST_FIRST) ?? [];
    expect(rangeStartPrice(candles)).toBe(100);
    expect(changePercent(100, 105)).toBeCloseTo(5);
    expect(changePercent(100, 95)).toBeCloseTo(-5);
  });

  it("reads the low and high across the candles", () => {
    const candles = parseReferenceCandles(NEWEST_FIRST) ?? [];
    expect(priceRange(candles)).toEqual({ low: 99, high: 102 });
    expect(priceRange([])).toBeNull();
  });

  it("has no change when the start price is unusable", () => {
    expect(rangeStartPrice([])).toBeNull();
    expect(changePercent(null, 100)).toBeNull();
    expect(changePercent(0, 100)).toBeNull();
    expect(changePercent(100, Number.NaN)).toBeNull();
  });
});
