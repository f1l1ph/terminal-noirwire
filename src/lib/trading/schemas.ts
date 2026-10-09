import { z } from "zod";

/**
 * Response shapes for the simulation service's local-development trading
 * routes. Not documented in sim-noirwire/docs/DESIGN.md (which covers only
 * the public read routes); these are this terminal's assumption about what
 * POST /v1/dev/orders, POST /v1/dev/cancel-all, GET /v1/dev/trader and
 * POST /v1/fund return. See docs/BUILD-NOTES.md.
 */

export const balanceSchema = z.object({
  asset: z.string(),
  total: z.string(),
  available: z.string(),
});

export const positionSchema = z.object({
  market: z.string(),
  side: z.enum(["buy", "sell"]),
  quantity: z.string(),
  entryPrice: z.string(),
  leverage: z.number(),
  liquidationPrice: z.string().nullable(),
  unrealizedPnl: z.string().nullable(),
});

export const openOrderSchema = z.object({
  orderId: z.string(),
  clientOrderId: z.string(),
  clientTag: z.string(),
  market: z.string(),
  side: z.enum(["buy", "sell"]),
  orderType: z.enum(["market", "limit"]),
  quantity: z.string(),
  filledQuantity: z.string(),
  limitPrice: z.string().nullable(),
  status: z.enum(["resting", "partiallyFilled"]),
  placedAt: z.number(),
  reduceOnly: z.boolean(),
});

export const ownFillSchema = z.object({
  fillId: z.string(),
  orderId: z.string(),
  clientTag: z.string(),
  market: z.string(),
  side: z.enum(["buy", "sell"]),
  price: z.string(),
  quantity: z.string(),
  fee: z.string(),
  time: z.number(),
});

export const traderStateSchema = z.object({
  balances: z.array(balanceSchema),
  positions: z.array(positionSchema),
  openOrders: z.array(openOrderSchema),
  ownFills: z.array(ownFillSchema),
});

export const placeOrderResponseSchema = z.object({
  orderId: z.string(),
  clientOrderId: z.string(),
  status: z.enum(["accepted", "rejected"]),
  reason: z.string().optional(),
  confirmedAt: z.number(),
});

export const cancelResponseSchema = z.object({
  cancelled: z.number(),
});

export const fundResponseSchema = z.object({
  amount: z.string(),
  reference: z.string(),
});
