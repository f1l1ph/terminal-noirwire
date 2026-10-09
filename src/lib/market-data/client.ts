import {
  candlesResponseSchema,
  healthResponseSchema,
  marketsResponseSchema,
  statsResponseSchema,
  tapeResponseSchema,
  type Candle,
  type CandleInterval,
  type MarketInfo,
  type PublicFill,
  type StatsResponse,
} from "@/lib/sim-api/schema";

export class MarketDataRequestError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "MarketDataRequestError";
  }
}

async function getJson(baseUrl: string, path: string): Promise<unknown> {
  const url = `${baseUrl}${path}`;
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "application/json" } });
  } catch {
    throw new MarketDataRequestError(`Could not reach the simulation service at ${url}`, url);
  }
  if (!response.ok) {
    throw new MarketDataRequestError(`${url} answered ${response.status}`, url, response.status);
  }
  return response.json();
}

export async function fetchHealth(baseUrl: string) {
  return healthResponseSchema.parse(await getJson(baseUrl, "/v1/health"));
}

export async function fetchMarkets(baseUrl: string): Promise<MarketInfo[]> {
  return marketsResponseSchema.parse(await getJson(baseUrl, "/v1/markets")).markets;
}

export async function fetchTape(
  baseUrl: string,
  market: string,
  limit = 100,
): Promise<PublicFill[]> {
  const path = `/v1/tape?market=${encodeURIComponent(market)}&limit=${limit}`;
  return tapeResponseSchema.parse(await getJson(baseUrl, path)).fills;
}

export async function fetchCandles(
  baseUrl: string,
  market: string,
  interval: CandleInterval,
  limit = 200,
): Promise<Candle[]> {
  const path = `/v1/candles?market=${encodeURIComponent(market)}&interval=${interval}&limit=${limit}`;
  return candlesResponseSchema.parse(await getJson(baseUrl, path)).candles;
}

export async function fetchStats(baseUrl: string): Promise<StatsResponse> {
  return statsResponseSchema.parse(await getJson(baseUrl, "/v1/stats"));
}
