import { z } from "zod";

/**
 * Shapes matching sim-noirwire/docs/DESIGN.md. The service's code did not
 * exist yet when this was written (see docs/BUILD-NOTES.md for every
 * assumption made here that needs reconciling against the real service).
 * Every response is parsed through these schemas: a field the service
 * doesn't actually send fails loudly in development rather than rendering
 * silently wrong numbers.
 */

export const MARKET_IDS = ["NSOL-PERP", "NNVDA-PERP", "NSOL-NUSD"] as const;
export type KnownMarketId = (typeof MARKET_IDS)[number];

export const marketKindSchema = z.enum(["perp", "spot"]);
export type MarketKind = z.infer<typeof marketKindSchema>;

export const marketInfoSchema = z.object({
  id: z.string(),
  kind: marketKindSchema,
  baseSymbol: z.string(),
  quoteSymbol: z.string(),
  tickSize: z.string(),
  lotSize: z.string(),
  minSize: z.string(),
  maxSize: z.string().nullable(),
  maxLeverage: z.number().int().positive(),
  priceDecimals: z.number().int().nonnegative(),
  sizeDecimals: z.number().int().nonnegative(),
  takerFeeBps: z.number().nonnegative(),
  makerFeeBps: z.number().nonnegative(),
  markPrice: z.string(),
  markPriceUpdatedAt: z.number(),
  change24h: z.number().nullable(),
  volume24h: z.string(),
  openInterest: z.string().nullable(),
  network: z.string(),
  simulated: z.boolean(),
});
export type MarketInfo = z.infer<typeof marketInfoSchema>;

export const marketListSchema = z.array(marketInfoSchema);

export const publicFillSchema = z.object({
  market: z.string(),
  price: z.string(),
  size: z.string(),
  takerSide: z.enum(["buy", "sell"]),
  time: z.number(),
  sequence: z.number(),
  tag: z.string().nullable(),
});
export type PublicFill = z.infer<typeof publicFillSchema>;

export const tapeSchema = z.array(publicFillSchema);

export const candleIntervalSchema = z.enum(["1m", "5m", "15m", "1h"]);
export type CandleInterval = z.infer<typeof candleIntervalSchema>;

export const candleSchema = z.object({
  startTime: z.number(),
  open: z.string(),
  high: z.string(),
  low: z.string(),
  close: z.string(),
  volume: z.string(),
});
export type Candle = z.infer<typeof candleSchema>;

export const candlesSchema = z.array(candleSchema);

export const latencyStatsSchema = z.object({
  p50Ms: z.number().nullable(),
  p99Ms: z.number().nullable(),
  sampleCount: z.number().int().nonnegative(),
  windowStart: z.number(),
  windowEnd: z.number(),
  measuredFrom: z.string(),
});
export type LatencyStats = z.infer<typeof latencyStatsSchema>;

export const venueStatsSchema = z.object({
  orders: z.number().int().nonnegative(),
  fills: z.number().int().nonnegative(),
  volume: z.string(),
  traders: z.number().int().nonnegative(),
  latency: latencyStatsSchema,
  updatedAt: z.number(),
  network: z.string(),
  simulated: z.boolean(),
});
export type VenueStats = z.infer<typeof venueStatsSchema>;

export const healthSchema = z.object({
  ok: z.boolean(),
  venue: z.string(),
  network: z.string(),
});

export const wsMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("price"), market: z.string(), price: z.string(), time: z.number() }),
  z.object({ type: z.literal("fill"), market: z.string(), fill: publicFillSchema }),
  z.object({
    type: z.literal("candle"),
    market: z.string(),
    interval: candleIntervalSchema,
    candle: candleSchema,
  }),
  z.object({ type: z.literal("stats"), stats: venueStatsSchema }),
]);
export type WsMessage = z.infer<typeof wsMessageSchema>;

export const MIN_LATENCY_SAMPLE_SIZE = 20;
