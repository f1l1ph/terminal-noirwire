import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  cancelAllResponseSchema,
  candlesResponseSchema,
  devOrderResponseSchema,
  fundResponseSchema,
  healthResponseSchema,
  marketsResponseSchema,
  statsResponseSchema,
  tapeResponseSchema,
  traderStateResponseSchema,
  type CandleInterval,
  type MarketInfo,
  type MarketKind,
  type OpenOrder,
  type PublicFill,
  type Side,
} from "../../src/lib/sim-api/schema.ts";

/**
 * A small stand-in for sim-noirwire, built to the exact wire shapes in
 * `src/lib/sim-api/schema.ts` (every response is run through that schema's
 * `.parse()` before being sent, so this server cannot silently drift from
 * what the real DevTradingClient expects). Market configuration (tick, lot,
 * max leverage) mirrors sim-noirwire's `src/engine/markets.ts`. It never
 * talks to a real chain or a real price feed; everything here is scripted
 * or randomly walked, for the Playwright suite only.
 */

interface MarketConfig {
  id: string;
  kind: MarketKind;
  base: string;
  quote: string;
  tickSize: number;
  lotSize: number;
  maxLeverage: number;
  takerFeeBps: number;
  basePrice: number;
}

/** See the partial-fill affordance in `placeOrder` below. */
const PARTIAL_FILL_TEST_THRESHOLD = 3;

const MARKETS: MarketConfig[] = [
  {
    id: "NSOL-PERP",
    kind: "perp",
    base: "SOL",
    quote: "nUSD",
    tickSize: 0.01,
    lotSize: 0.001,
    maxLeverage: 10,
    takerFeeBps: 5,
    basePrice: 150,
  },
  {
    id: "NNVDA-PERP",
    kind: "perp",
    base: "NVDAx",
    quote: "nUSD",
    tickSize: 0.01,
    lotSize: 0.0001,
    maxLeverage: 10,
    takerFeeBps: 5,
    basePrice: 120,
  },
  {
    id: "NSOL-NUSD",
    kind: "spot",
    base: "SOL",
    quote: "nUSD",
    tickSize: 0.01,
    lotSize: 0.001,
    maxLeverage: 0,
    takerFeeBps: 5,
    basePrice: 150,
  },
];

interface MarketState {
  markPrice: number;
  markPriceUpdatedAtMs: number;
  candles1m: {
    startMs: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }[];
  tape: PublicFill[];
  volume24h: number;
  openInterest: number;
  change24h: number;
  sequence: number;
}

interface Balance {
  balance: number;
  locked: number;
}

interface Position {
  size: number;
  entryPrice: number;
}

interface Trader {
  balances: Map<string, Balance>;
  positions: Map<string, Position>;
  openOrders: Map<string, OpenOrder>;
  funded: boolean;
}

const marketStates = new Map<string, MarketState>();
const traders = new Map<string, Trader>();
let orderSeq = 0;
const latenciesMs: number[] = [];
let wsBlocked = false;
const sockets = new Map<WebSocket, string>();

function round(value: number, decimals = 6): string {
  return value.toFixed(decimals);
}

function randomTag(): string {
  return randomBytes(8).readBigUInt64BE(0).toString();
}

function resetState(): void {
  marketStates.clear();
  traders.clear();
  orderSeq = 0;
  latenciesMs.length = 0;
  wsBlocked = false;
  const now = Date.now();
  // Minute-aligned, the same rounding the live tick below uses for its own
  // in-progress candle: a seeded candle one second off that alignment
  // produced a timestamp earlier than the tick's next "current minute"
  // candle, which broke lightweight-charts' ascending-time requirement the
  // moment the first live candle arrived.
  const currentMinute = Math.floor(now / 60_000) * 60_000;
  for (const market of MARKETS) {
    const candles = [];
    let price = market.basePrice;
    for (let i = 20; i >= 0; i -= 1) {
      const startMs = currentMinute - i * 60_000;
      const open = price;
      price = price * (1 + (Math.random() - 0.5) * 0.004);
      candles.push({
        startMs,
        open,
        high: Math.max(open, price),
        low: Math.min(open, price),
        close: price,
        volume: 10 + Math.random() * 20,
      });
    }
    marketStates.set(market.id, {
      markPrice: price,
      markPriceUpdatedAtMs: now,
      candles1m: candles,
      tape: [],
      volume24h: 50_000,
      openInterest: market.kind === "perp" ? 20_000 : 0,
      change24h: (Math.random() - 0.5) * 4,
      sequence: 0,
    });
  }
  // Seeded so the venue pulse shows a real reading immediately in the suite
  // (sim-noirwire's own /v1/stats never populates this: see docs/BUILD-NOTES.md).
  for (let i = 0; i < 40; i += 1) latenciesMs.push(80 + Math.random() * 400);
}

function getTrader(address: string): Trader {
  let trader = traders.get(address);
  if (!trader) {
    trader = { balances: new Map(), positions: new Map(), openOrders: new Map(), funded: false };
    traders.set(address, trader);
  }
  return trader;
}

function getBalance(trader: Trader, asset: string): Balance {
  let balance = trader.balances.get(asset);
  if (!balance) {
    balance = { balance: 0, locked: 0 };
    trader.balances.set(asset, balance);
  }
  return balance;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

function recordLatency(): void {
  latenciesMs.push(40 + Math.random() * 300);
  if (latenciesMs.length > 500) latenciesMs.shift();
}

function statsPayload() {
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  return statsResponseSchema.parse({
    network: "devnet",
    orders: { user: orderSeq, bot: 60 },
    fills: { user: 0, bot: 9 },
    volume: { user: "0.000000", bot: "2.841818" },
    tradersTotal: traders.size,
    latency: {
      medianMs: sorted.length ? Math.round(percentile(sorted, 50)) : 0,
      p99Ms: sorted.length ? Math.round(percentile(sorted, 99)) : 0,
      sampleSize: sorted.length,
      measuredFrom: "http:request",
    },
    updatedAtMs: Date.now(),
  });
}

function wsStatsPayload() {
  const full = statsPayload();
  return {
    user: { orders: full.orders.user, fills: full.fills.user, volume: full.volume.user },
    bot: { orders: full.orders.bot, fills: full.fills.bot, volume: full.volume.bot },
    tradersTotal: full.tradersTotal,
    latency: full.latency,
    updatedAtMs: full.updatedAtMs,
  };
}

function marketInfoPayload(market: MarketConfig): MarketInfo {
  const state = marketStates.get(market.id)!;
  return {
    id: market.id,
    kind: market.kind,
    base: market.base,
    quote: market.quote,
    tickSize: round(market.tickSize),
    lotSize: round(market.lotSize),
    maxLeverage: market.maxLeverage,
    markPrice: round(state.markPrice),
    markPriceUpdatedAtMs: state.markPriceUpdatedAtMs,
    change24hPercent: state.change24h,
    volume24h: round(state.volume24h),
    openInterest: market.kind === "perp" ? round(state.openInterest) : null,
  };
}

/** Float-safe "is `value` a whole multiple of `step`", scaling both to integers first. */
function isMultipleOf(value: number, step: number): boolean {
  const scale = 1e8;
  const scaledValue = Math.round(value * scale);
  const scaledStep = Math.round(step * scale);
  if (scaledStep <= 0) return true;
  return scaledValue % scaledStep === 0;
}

function nextOrderId(): string {
  orderSeq += 1;
  return `ord-${orderSeq}`;
}

function broadcast(market: string, message: unknown): void {
  const payload = JSON.stringify(message);
  for (const [socket, subscribedMarket] of sockets) {
    if (subscribedMarket !== market) continue;
    if (socket.readyState === socket.OPEN) socket.send(payload);
  }
}

function broadcastToAll(message: unknown): void {
  const payload = JSON.stringify(message);
  for (const socket of sockets.keys()) {
    if (socket.readyState === socket.OPEN) socket.send(payload);
  }
}

function recordFill(params: {
  market: MarketConfig;
  trader: Trader;
  orderId: string;
  tag: string;
  side: Side;
  quantity: number;
  price: number;
  fee: number;
}): void {
  const { market, trader, tag, side, quantity, price, fee } = params;
  const quote = getBalance(trader, market.quote);
  if (market.kind === "spot") {
    const base = getBalance(trader, market.base);
    if (side === "buy") {
      quote.balance -= quantity * price + fee;
      base.balance += quantity;
    } else {
      quote.balance += quantity * price - fee;
      base.balance -= quantity;
    }
  } else {
    quote.balance -= fee;
    const existing = trader.positions.get(market.id) ?? { size: 0, entryPrice: 0 };
    const signedDelta = side === "buy" ? quantity : -quantity;
    const newSize = existing.size + signedDelta;
    if (existing.size === 0 || Math.sign(existing.size) === Math.sign(signedDelta)) {
      const oldNotional = Math.abs(existing.size) * existing.entryPrice;
      const addedNotional = Math.abs(signedDelta) * price;
      trader.positions.set(market.id, {
        size: newSize,
        entryPrice: newSize === 0 ? 0 : (oldNotional + addedNotional) / Math.abs(newSize),
      });
    } else {
      const realized =
        Math.min(Math.abs(signedDelta), Math.abs(existing.size)) *
        Math.sign(existing.size) *
        (price - existing.entryPrice);
      quote.balance += realized;
      trader.positions.set(market.id, {
        size: newSize,
        entryPrice: newSize === 0 ? 0 : existing.entryPrice,
      });
    }
  }
  const state = marketStates.get(market.id)!;
  state.sequence += 1;
  const fill: PublicFill = {
    market: market.id,
    price: round(price),
    size: round(quantity),
    takerSide: side,
    takerTag: tag,
    makerTag: randomTag(),
    timestampMs: Date.now(),
    sequence: state.sequence,
  };
  state.tape.unshift(fill);
  state.tape = state.tape.slice(0, 200);
  broadcast(market.id, { type: "fill", ...fill });
}

type OrderOutcome = { httpStatus: number; body: unknown };

function placeOrder(body: Record<string, unknown>): OrderOutcome {
  const market = MARKETS.find((item) => item.id === body.market);
  const tag = randomTag();
  const orderId = nextOrderId();
  recordLatency();

  const reject = (reason: string, size: string): OrderOutcome => ({
    httpStatus: 200,
    body: devOrderResponseSchema.parse({
      orderId,
      tag,
      status: "rejected",
      filledSize: "0.000000",
      remainingSize: size,
      reason,
    }),
  });

  if (!market) return reject("unknown market", String(body.size ?? "0"));

  const trader = getTrader(String(body.address));
  const side = body.side as Side;
  const type = body.type as "market" | "limit";
  const size = Number(body.size);
  const price = Number(body.price);

  if (!(size > 0)) return reject("size must be positive", String(body.size ?? "0"));
  if (!isMultipleOf(size, market.lotSize)) {
    return reject("size must be a multiple of the lot size", String(body.size));
  }
  if (!(price > 0)) return reject("price must be positive", String(body.size));
  if (!isMultipleOf(price, market.tickSize)) {
    return reject("price must be a multiple of the tick size", String(body.size));
  }

  if (market.kind === "perp" && body.reduceOnly) {
    const existing = trader.positions.get(market.id);
    const reducesDirection =
      (side === "sell" && (existing?.size ?? 0) > 0) ||
      (side === "buy" && (existing?.size ?? 0) < 0);
    if (!reducesDirection) {
      return reject("reduce-only: no position to reduce", String(body.size));
    }
  }

  const state = marketStates.get(market.id)!;
  const notional = size * price;
  const fee = (notional * market.takerFeeBps) / 10_000;
  const quote = getBalance(trader, market.quote);

  if (market.kind === "spot") {
    if (side === "buy" && quote.balance < notional + fee)
      return reject("insufficient balance", String(body.size));
    if (side === "sell") {
      const base = getBalance(trader, market.base);
      if (base.balance < size) return reject("insufficient balance", String(body.size));
    }
  } else {
    // The venue has no per-order leverage field: margin is always the
    // market's fixed ratio (equivalent to its advertised maxLeverage, see
    // sim-noirwire's engine/markets.ts initialMarginBps), not a client choice.
    const margin = notional / Math.max(1, market.maxLeverage);
    if (quote.balance < margin + fee) return reject("insufficient margin", String(body.size));
  }

  const willFillNow =
    type === "market" || (side === "buy" ? price >= state.markPrice : price <= state.markPrice);

  // Test-only affordance for the Playwright suite's partial-fill screenshot:
  // this fake engine is otherwise strictly all-or-nothing (sim-noirwire's
  // real book can of course match less than a resting order's full size
  // against thin depth; this fixture has no depth model to produce that
  // naturally). A size above PARTIAL_FILL_TEST_THRESHOLD fills only that
  // much now and rests the remainder, exactly like a real partial match.
  if (willFillNow && size > PARTIAL_FILL_TEST_THRESHOLD) {
    const filledNow = PARTIAL_FILL_TEST_THRESHOLD;
    const remaining = round(size - filledNow);
    recordFill({
      market,
      trader,
      orderId,
      tag,
      side,
      quantity: filledNow,
      price: type === "market" ? state.markPrice : price,
      fee: fee * (filledNow / size),
    });
    const order: OpenOrder = {
      orderId,
      tag,
      market: market.id,
      side,
      type,
      price: round(price),
      size: round(size),
      remainingSize: remaining,
      reduceOnly: Boolean(body.reduceOnly),
    };
    trader.openOrders.set(orderId, order);
    return {
      httpStatus: 200,
      body: devOrderResponseSchema.parse({
        orderId,
        tag,
        status: "partiallyFilled",
        filledSize: round(filledNow),
        remainingSize: remaining,
        reason: null,
      }),
    };
  }

  if (!willFillNow) {
    const order: OpenOrder = {
      orderId,
      tag,
      market: market.id,
      side,
      type,
      price: round(price),
      size: round(size),
      remainingSize: round(size),
      reduceOnly: Boolean(body.reduceOnly),
    };
    trader.openOrders.set(orderId, order);
    return {
      httpStatus: 200,
      body: devOrderResponseSchema.parse({
        orderId,
        tag,
        status: "open",
        filledSize: "0.000000",
        remainingSize: round(size),
        reason: null,
      }),
    };
  }

  recordFill({
    market,
    trader,
    orderId,
    tag,
    side,
    quantity: size,
    price: type === "market" ? state.markPrice : price,
    fee,
  });
  return {
    httpStatus: 200,
    body: devOrderResponseSchema.parse({
      orderId,
      tag,
      status: "filled",
      filledSize: round(size),
      remainingSize: "0.000000",
      reason: null,
    }),
  };
}

function cancelAll(address: string, marketId: string) {
  const trader = getTrader(address);
  let cancelled = 0;
  for (const [orderId, order] of trader.openOrders) {
    if (order.market !== marketId) continue;
    trader.openOrders.delete(orderId);
    cancelled += 1;
  }
  return cancelAllResponseSchema.parse({ cancelled });
}

function traderStatePayload(address: string) {
  const trader = getTrader(address);
  const balances: Record<string, { balance: string; locked: string }> = {};
  for (const [asset, balance] of trader.balances) {
    balances[asset] = { balance: round(balance.balance), locked: round(balance.locked) };
  }
  const positions: Record<string, { size: string; entryPrice: string }> = {};
  for (const [marketId, position] of trader.positions) {
    if (position.size !== 0)
      positions[marketId] = { size: round(position.size), entryPrice: round(position.entryPrice) };
  }
  const equity =
    (trader.balances.get("nUSD")?.balance ?? 0) + (trader.balances.get("nUSD")?.locked ?? 0);
  return traderStateResponseSchema.parse({
    trader: address,
    equity: round(equity),
    balances,
    positions,
    openOrders: Array.from(trader.openOrders.values()),
  });
}

const FUNDED_ADDRESSES = new Set<string>();

function fund(address: string): OrderOutcome {
  if (FUNDED_ADDRESSES.has(address)) {
    return { httpStatus: 409, body: { error: "this address already received its fund grant" } };
  }
  FUNDED_ADDRESSES.add(address);
  const trader = getTrader(address);
  const balance = getBalance(trader, "nUSD");
  balance.balance += 5000;
  return {
    httpStatus: 200,
    body: fundResponseSchema.parse({
      amount: round(5000),
      reference: `fund-${address.slice(0, 8)}-${Date.now()}`,
    }),
  };
}

function aggregateCandles(oneMinute: MarketState["candles1m"], minutesPerCandle: number) {
  const result: {
    startMs: number;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
  }[] = [];
  for (let i = 0; i < oneMinute.length; i += minutesPerCandle) {
    const chunk = oneMinute.slice(i, i + minutesPerCandle);
    if (chunk.length === 0) continue;
    result.push({
      startMs: chunk[0].startMs,
      open: round(chunk[0].open),
      high: round(Math.max(...chunk.map((c) => c.high))),
      low: round(Math.min(...chunk.map((c) => c.low))),
      close: round(chunk.at(-1)!.close),
      volume: round(chunk.reduce((sum, c) => sum + c.volume, 0)),
    });
  }
  return result;
}

function candlesPayload(marketId: string, interval: CandleInterval, limit: number) {
  const state = marketStates.get(marketId);
  if (!state) return [];
  const perCandle = interval === "1m" ? 1 : interval === "5m" ? 5 : interval === "15m" ? 15 : 60;
  return aggregateCandles(state.candles1m, perCandle).slice(-limit);
}

function send(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, accept",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(
  req: import("node:http").IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    send(res, 204, {});
    return;
  }

  if (req.method === "GET" && path === "/v1/health") {
    send(res, 200, healthResponseSchema.parse({ ok: true, venue: "memory", network: "devnet" }));
    return;
  }

  if (req.method === "GET" && path === "/v1/markets") {
    send(
      res,
      200,
      marketsResponseSchema.parse({
        network: "devnet",
        simulated: true,
        markets: MARKETS.map(marketInfoPayload),
      }),
    );
    return;
  }

  if (req.method === "GET" && path === "/v1/tape") {
    const market = url.searchParams.get("market") ?? "";
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const state = marketStates.get(market);
    send(
      res,
      200,
      tapeResponseSchema.parse({
        network: "devnet",
        simulated: true,
        fills: state ? state.tape.slice(0, limit) : [],
      }),
    );
    return;
  }

  if (req.method === "GET" && path === "/v1/candles") {
    const market = url.searchParams.get("market") ?? "";
    const interval = (url.searchParams.get("interval") ?? "1m") as CandleInterval;
    const limit = Number(url.searchParams.get("limit") ?? "200");
    send(
      res,
      200,
      candlesResponseSchema.parse({
        network: "devnet",
        simulated: true,
        candles: candlesPayload(market, interval, limit),
      }),
    );
    return;
  }

  if (req.method === "GET" && path === "/v1/stats") {
    send(res, 200, statsPayload());
    return;
  }

  if (req.method === "GET" && path === "/v1/dev/trader") {
    const address = url.searchParams.get("address") ?? "";
    send(res, 200, traderStatePayload(address));
    return;
  }

  if (req.method === "POST" && path === "/v1/fund") {
    void readJsonBody(req).then((body) => {
      const result = fund(String(body.address));
      send(res, result.httpStatus, result.body);
    });
    return;
  }

  if (req.method === "POST" && path === "/v1/dev/orders") {
    void readJsonBody(req).then((body) => {
      const result = placeOrder(body);
      send(res, result.httpStatus, result.body);
    });
    return;
  }

  if (req.method === "POST" && path === "/v1/dev/cancel-all") {
    void readJsonBody(req).then((body) => {
      send(res, 200, cancelAll(String(body.address), String(body.market)));
    });
    return;
  }

  if (req.method === "POST" && path === "/__control/reset") {
    resetState();
    send(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && path === "/__control/disconnect") {
    wsBlocked = true;
    for (const socket of sockets.keys()) socket.close();
    send(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && path === "/__control/reconnect") {
    wsBlocked = false;
    send(res, 200, { ok: true });
    return;
  }

  send(res, 404, { error: "not found" });
});

const wss = new WebSocketServer({ server, path: "/v1/stream" });
wss.on("connection", (socket, request) => {
  if (wsBlocked) {
    socket.close();
    return;
  }
  const market = new URL(request.url ?? "/", "http://localhost").searchParams.get("market") ?? "";
  sockets.set(socket, market);
  socket.on("close", () => sockets.delete(socket));
});

const TICK_MS = 1000;
setInterval(() => {
  if (wsBlocked) return;
  const now = Date.now();
  for (const market of MARKETS) {
    const state = marketStates.get(market.id)!;
    state.markPrice = Math.max(0.01, state.markPrice * (1 + (Math.random() - 0.5) * 0.003));
    state.markPriceUpdatedAtMs = now;
    broadcast(market.id, {
      type: "price",
      market: market.id,
      price: round(state.markPrice),
      publishedAtMs: now,
    });

    const lastCandle = state.candles1m.at(-1);
    const candleStart = Math.floor(now / 60_000) * 60_000;
    if (lastCandle && lastCandle.startMs === candleStart) {
      lastCandle.close = state.markPrice;
      lastCandle.high = Math.max(lastCandle.high, state.markPrice);
      lastCandle.low = Math.min(lastCandle.low, state.markPrice);
    } else {
      state.candles1m.push({
        startMs: candleStart,
        open: state.markPrice,
        high: state.markPrice,
        low: state.markPrice,
        close: state.markPrice,
        volume: 1,
      });
      if (state.candles1m.length > 500) state.candles1m.shift();
    }
    const current = state.candles1m.at(-1)!;
    broadcast(market.id, {
      type: "candle",
      market: market.id,
      interval: "1m",
      candle: {
        startMs: current.startMs,
        open: round(current.open),
        high: round(current.high),
        low: round(current.low),
        close: round(current.close),
        volume: round(current.volume),
      },
    });
  }
  broadcastToAll({ type: "stats", stats: wsStatsPayload() });
}, TICK_MS);

resetState();

const port = Number(process.argv[2] ?? process.env.FAKE_SIM_PORT ?? 4200);
server.listen(port, () => {
  console.log(`Fake sim-noirwire listening on ${port}`);
});
