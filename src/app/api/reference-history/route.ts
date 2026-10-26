import {
  isHistoryRange,
  parseReferenceCandles,
  referenceHistoryUrl,
} from "@/lib/market-data/reference-history";

const UPSTREAM_TIMEOUT_MS = 5_000;
const CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=120";

function json(body: unknown, status: number, cacheControl: string): Response {
  return Response.json(body, { status, headers: { "Cache-Control": cacheControl } });
}

/**
 * SOL/USD reference candles for the chart, fetched here so visitors'
 * browsers never contact the price source. Only validated candles leave
 * this route; an upstream failure is a bare 502 with nothing echoed.
 */
export async function GET(request: Request): Promise<Response> {
  const range = new URL(request.url).searchParams.get("range");
  if (!isHistoryRange(range)) {
    return json({ error: "range must be 1H, 1D, 1W or 1M" }, 400, "no-store");
  }
  // Whole minutes, so every call within a minute asks upstream for the same URL and shares one cached answer.
  const minuteMs = Math.floor(Date.now() / 60_000) * 60_000;
  try {
    const upstream = await fetch(referenceHistoryUrl(range, minuteMs), {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      next: { revalidate: 60 },
    });
    if (!upstream.ok) throw new Error("upstream status");
    const candles = parseReferenceCandles(await upstream.json());
    if (!candles) throw new Error("upstream malformed");
    return json({ candles }, 200, CACHE_CONTROL);
  } catch {
    return json({ error: "reference history unavailable" }, 502, "no-store");
  }
}
