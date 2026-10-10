import { z } from "zod";

/**
 * The one source of truth for every shape sim-noirwire's API returns or
 * accepts, read from its own source (src/http/routes/*.ts, src/http/hub.ts,
 * src/http/serialize.ts, src/engine/types.ts) in that repository. Both
 * `src/lib/market-data`, `src/lib/trading`, and `e2e/fake-sim/server.mts`
 * import from here, so the deterministic test double and the real client
 * can never drift apart silently.
 *
 * Every price, size and balance is a plain decimal string, scaled from the
 * engine's internal fixed-point integers (never a float, never a raw
 * bigint). A trader's own 64-bit tag (assigned by the venue when it places
 * an order) is also a decimal string, never a client-generated value: see
 * docs/BUILD-NOTES.md, "How 'yours' is recognised."
 */

export const MARKET_IDS = ["NSOL-PERP", "NNVDA-PERP", "NSOL-NUSD"] as const;
export type KnownMarketId = (typeof MARKET_IDS)[number];

export const marketKindSchema = z.enum(["perp", "spot"]);
export type MarketKind = z.infer<typeof marketKindSchema>;

export const sideSchema = z.enum(["buy", "sell"]);
export type Side = z.infer<typeof sideSchema>;

/** The order types this terminal exposes. The venue also has `postOnly`; cut here (YAGNI, not asked for). */
export const orderTypeSchema = z.enum(["market", "limit"]);
export type OrderType = z.infer<typeof orderTypeSchema>;

export const orderStatusSchema = z.enum([
  "open",
  "filled",
  "partiallyFilled",
  "cancelled",
  "rejected",
]);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

export const marketInfoSchema = z.object({
  id: z.string(),
  kind: marketKindSchema,
  base: z.string(),
  quote: z.string(),
  tickSize: z.string(),
  lotSize: z.string(),
  maxLeverage: z.number().int().nonnegative(),
  markPrice: z.string().nullable(),
  markPriceUpdatedAtMs: z.number().nullable(),
  change24hPercent: z.number().nullable(),
  volume24h: z.string(),
  openInterest: z.string().nullable(),
});
export type MarketInfo = z.infer<typeof marketInfoSchema>;

export const marketsResponseSchema = z.object({
  network: z.string(),
  simulated: z.boolean(),
  markets: z.array(marketInfoSchema),
});

export const publicFillSchema = z.object({
  market: z.string(),
  price: z.string(),
  size: z.string(),
  takerSide: sideSchema,
  takerTag: z.string(),
  makerTag: z.string(),
  timestampMs: z.number(),
  sequence: z.number(),
});
export type PublicFill = z.infer<typeof publicFillSchema>;

export const tapeResponseSchema = z.object({
  network: z.string(),
  simulated: z.boolean(),
  fills: z.array(publicFillSchema),
});

export const candleIntervalSchema = z.enum(["1m", "5m", "15m", "1h"]);
export type CandleInterval = z.infer<typeof candleIntervalSchema>;

export const candleSchema = z.object({
  startMs: z.number(),
  open: z.string(),
  high: z.string(),
  low: z.string(),
  close: z.string(),
  volume: z.string(),
});
export type Candle = z.infer<typeof candleSchema>;

export const candlesResponseSchema = z.object({
  network: z.string(),
  simulated: z.boolean(),
  candles: z.array(candleSchema),
});

export const latencyStatsSchema = z.object({
  medianMs: z.number(),
  p99Ms: z.number(),
  sampleSize: z.number().int().nonnegative(),
  measuredFrom: z.string(),
});
export type LatencyStats = z.infer<typeof latencyStatsSchema>;

const activitySplitSchema = z.object({ user: z.number(), bot: z.number() });
const volumeSplitSchema = z.object({ user: z.string(), bot: z.string() });

export const statsResponseSchema = z.object({
  network: z.string(),
  orders: activitySplitSchema,
  fills: activitySplitSchema,
  volume: volumeSplitSchema,
  tradersTotal: z.number().int().nonnegative(),
  latency: latencyStatsSchema,
  updatedAtMs: z.number(),
});
export type StatsResponse = z.infer<typeof statsResponseSchema>;

export const healthResponseSchema = z.object({
  ok: z.boolean(),
  venue: z.string(),
  network: z.string(),
});

const wsActivitySchema = z.object({ orders: z.number(), fills: z.number(), volume: z.string() });

/** The websocket's `stats` message carries no `network` field; see hub.ts's `serializeStats`. */
const wsStatsSchema = z.object({
  user: wsActivitySchema,
  bot: wsActivitySchema,
  tradersTotal: z.number().int().nonnegative(),
  latency: latencyStatsSchema,
  updatedAtMs: z.number(),
});
export type WsStats = z.infer<typeof wsStatsSchema>;

export const wsMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("price"),
    market: z.string(),
    price: z.string(),
    publishedAtMs: z.number(),
  }),
  z.object({
    type: z.literal("fill"),
    market: z.string(),
    price: z.string(),
    size: z.string(),
    takerSide: sideSchema,
    takerTag: z.string(),
    makerTag: z.string(),
    timestampMs: z.number(),
    sequence: z.number(),
  }),
  z.object({
    type: z.literal("candle"),
    market: z.string(),
    interval: candleIntervalSchema,
    candle: candleSchema,
  }),
  z.object({ type: z.literal("stats"), stats: wsStatsSchema }),
]);
export type WsMessage = z.infer<typeof wsMessageSchema>;

export const MIN_LATENCY_SAMPLE_SIZE = 20;

// ---------------------------------------------------------------------------
// Dev trading (POST /v1/dev/orders, POST /v1/dev/cancel-all, GET /v1/dev/trader)
// Registered only when VENUE=memory and DEV_TRADING=1.
// ---------------------------------------------------------------------------

const decimalAmountSchema = z.string().regex(/^\d+(\.\d+)?$/, "must be a plain decimal number");

/**
 * Every order type requires a price: it is the matching bound for `market`
 * and `ioc`, and the resting price for `limit` (and `postOnly`, not exposed
 * here). There is no separate "protection bound" field - the venue already
 * requires a worst price on a market order, so this terminal's `price` on a
 * market order IS that bound. See sim-noirwire's
 * `MemoryVenue.validateShape`.
 */
export const devOrderRequestSchema = z.object({
  address: z.string().min(1),
  market: z.enum(MARKET_IDS),
  side: sideSchema,
  type: orderTypeSchema,
  price: decimalAmountSchema,
  size: decimalAmountSchema,
  reduceOnly: z.boolean().optional(),
});

export const devOrderResponseSchema = z.object({
  orderId: z.string(),
  tag: z.string(),
  status: orderStatusSchema,
  filledSize: z.string(),
  remainingSize: z.string(),
  reason: z.string().nullable(),
});

export const cancelAllResponseSchema = z.object({ cancelled: z.number().int().nonnegative() });

export const tokenBalanceSchema = z.object({ balance: z.string(), locked: z.string() });

export const perpPositionSchema = z.object({ size: z.string(), entryPrice: z.string() });

export const openOrderSchema = z.object({
  orderId: z.string(),
  tag: z.string(),
  market: z.string(),
  side: sideSchema,
  type: z.string(),
  price: z.string().nullable(),
  size: z.string(),
  remainingSize: z.string(),
  reduceOnly: z.boolean(),
});
export type OpenOrder = z.infer<typeof openOrderSchema>;

export const traderStateResponseSchema = z.object({
  trader: z.string(),
  equity: z.string(),
  balances: z.record(z.string(), tokenBalanceSchema),
  positions: z.record(z.string(), perpPositionSchema),
  openOrders: z.array(openOrderSchema),
});

export const fundResponseSchema = z.object({ amount: z.string(), reference: z.string() });

/** `{ error }` for a 400/409/429; see fund.ts and fund-ledger.ts. */
export const errorResponseSchema = z.object({ error: z.string() });
