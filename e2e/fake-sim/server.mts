import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * A small stand-in for sim-noirwire, serving the routes documented in
 * sim-noirwire/docs/DESIGN.md plus the dev trading routes this terminal
 * assumes (see docs/BUILD-NOTES.md). It never talks to a real chain or a
 * real price feed; everything here is scripted or randomly walked, for the
 * Playwright suite only.
 */

interface MarketConfig {
  id: string;
  kind: "perp" | "spot";
  baseSymbol: string;
  quoteSymbol: string;
  tickSize: string;
  lotSize: string;
  minSize: string;
  maxSize: string;
  maxLeverage: number;
  priceDecimals: number;
  sizeDecimals: number;
  takerFeeBps: number;
  makerFeeBps: number;
  basePrice: number;
}

const MARKETS: MarketConfig[] = [
  {
    id: "NSOL-PERP",
    kind: "perp",
    baseSymbol: "NSOL",
    quoteSymbol: "nUSD",
    tickSize: "0.01",
    lotSize: "0.1",
    minSize: "0.1",
    maxSize: "500",
    maxLeverage: 20,
    priceDecimals: 2,
    sizeDecimals: 1,
    takerFeeBps: 10,
    makerFeeBps: 2,
    basePrice: 150,
  },
  {
    id: "NNVDA-PERP",
    kind: "perp",
    baseSymbol: "NNVDA",
    quoteSymbol: "nUSD",
    tickSize: "0.01",
    lotSize: "0.01",
    minSize: "0.01",
    maxSize: "200",
    maxLeverage: 10,
    priceDecimals: 2,
    sizeDecimals: 2,
    takerFeeBps: 10,
    makerFeeBps: 2,
    basePrice: 120,
  },
  {
    id: "NSOL-NUSD",
    kind: "spot",
    baseSymbol: "NSOL",
    quoteSymbol: "nUSD",
    tickSize: "0.01",
    lotSize: "0.1",
    minSize: "0.1",
    maxSize: "500",
    maxLeverage: 1,
    priceDecimals: 2,
    sizeDecimals: 1,
    takerFeeBps: 10,
    makerFeeBps: 2,
    basePrice: 150,
  },
];

interface MarketState {
  markPrice: number;
  markPriceUpdatedAt: number;
  candles1m: {
    startTime: number;
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

interface PublicFill {
  market: string;
  price: string;
  size: string;
  takerSide: "buy" | "sell";
  time: number;
  sequence: number;
  tag: string | null;
}

interface Balance {
  asset: string;
  total: number;
  available: number;
}

interface Position {
  market: string;
  side: "buy" | "sell";
  quantity: number;
  entryPrice: number;
  leverage: number;
}

interface OpenOrder {
  orderId: string;
  clientOrderId: string;
  clientTag: string;
  market: string;
  side: "buy" | "sell";
  orderType: "market" | "limit";
  quantity: string;
  filledQuantity: string;
  limitPrice: string | null;
  status: "resting" | "partiallyFilled";
  placedAt: number;
  reduceOnly: boolean;
}

interface OwnFill {
  fillId: string;
  orderId: string;
  clientTag: string;
  market: string;
  side: "buy" | "sell";
  price: string;
  quantity: string;
  fee: string;
  time: number;
}

interface Trader {
  balances: Map<string, Balance>;
  positions: Map<string, Position>;
  openOrders: Map<string, OpenOrder>;
  ownFills: OwnFill[];
  funded: boolean;
}

const marketStates = new Map<string, MarketState>();
const traders = new Map<string, Trader>();
let orderSeq = 0;
let fillSeq = 0;
const latenciesMs: number[] = [];
let wsBlocked = false;
const sockets = new Set<WebSocket>();

function resetState(): void {
  marketStates.clear();
  traders.clear();
  orderSeq = 0;
  fillSeq = 0;
  latenciesMs.length = 0;
  wsBlocked = false;
  const now = Date.now();
  for (const market of MARKETS) {
    const candles = [];
    let price = market.basePrice;
    for (let i = 20; i >= 0; i -= 1) {
      const startTime = now - i * 60_000;
      const open = price;
      price = price * (1 + (Math.random() - 0.5) * 0.004);
      candles.push({
        startTime,
        open,
        high: Math.max(open, price),
        low: Math.min(open, price),
        close: price,
        volume: 10 + Math.random() * 20,
      });
    }
    marketStates.set(market.id, {
      markPrice: price,
      markPriceUpdatedAt: now,
      candles1m: candles,
      tape: [],
      volume24h: 50_000,
      openInterest: market.kind === "perp" ? 20_000 : 0,
      change24h: (Math.random() - 0.5) * 4,
      sequence: 0,
    });
  }
  // Seeded so the venue pulse shows a real reading immediately in the suite.
  for (let i = 0; i < 40; i += 1) latenciesMs.push(80 + Math.random() * 400);
}

function getTrader(address: string): Trader {
  let trader = traders.get(address);
  if (!trader) {
    trader = {
      balances: new Map(),
      positions: new Map(),
      openOrders: new Map(),
      ownFills: [],
      funded: false,
    };
    traders.set(address, trader);
  }
  return trader;
}

function getBalance(trader: Trader, asset: string): Balance {
  let balance = trader.balances.get(asset);
  if (!balance) {
    balance = { asset, total: 0, available: 0 };
    trader.balances.set(asset, balance);
  }
  return balance;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

function statsSnapshot() {
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  return {
    orders: orderSeq,
    fills: fillSeq,
    volume: "125000",
    traders: traders.size,
    latency: {
      p50Ms: sorted.length ? Math.round(percentile(sorted, 50)) : null,
      p99Ms: sorted.length ? Math.round(percentile(sorted, 99)) : null,
      sampleCount: sorted.length,
      windowStart: Date.now() - 900_000,
      windowEnd: Date.now(),
      measuredFrom: "order placement to venue confirmation",
    },
    updatedAt: Date.now(),
    network: "devnet",
    simulated: true,
  };
}

function broadcast(message: unknown): void {
  const payload = JSON.stringify(message);
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) socket.send(payload);
  }
}

function round(value: number, decimals: number): string {
  return value.toFixed(decimals);
}

function marketInfoPayload(market: MarketConfig) {
  const state = marketStates.get(market.id)!;
  return {
    id: market.id,
    kind: market.kind,
    baseSymbol: market.baseSymbol,
    quoteSymbol: market.quoteSymbol,
    tickSize: market.tickSize,
    lotSize: market.lotSize,
    minSize: market.minSize,
    maxSize: market.maxSize,
    maxLeverage: market.maxLeverage,
    priceDecimals: market.priceDecimals,
    sizeDecimals: market.sizeDecimals,
    takerFeeBps: market.takerFeeBps,
    makerFeeBps: market.makerFeeBps,
    markPrice: round(state.markPrice, market.priceDecimals),
    markPriceUpdatedAt: state.markPriceUpdatedAt,
    change24h: state.change24h,
    volume24h: round(state.volume24h, 2),
    openInterest: market.kind === "perp" ? round(state.openInterest, market.sizeDecimals) : null,
    network: "devnet",
    simulated: true,
  };
}

function recordLatency(): void {
  latenciesMs.push(40 + Math.random() * 300);
  if (latenciesMs.length > 500) latenciesMs.shift();
}

function nextOrderId(): string {
  orderSeq += 1;
  return `order-${orderSeq}`;
}

function nextFillId(): string {
  fillSeq += 1;
  return `fill-${fillSeq}`;
}

function recordFill(params: {
  market: MarketConfig;
  trader: Trader;
  address: string;
  orderId: string;
  clientTag: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  fee: number;
  leverage: number;
}): void {
  const { market, trader, orderId, clientTag, side, quantity, price, fee, leverage } = params;
  const quote = getBalance(trader, market.quoteSymbol);
  const base = getBalance(trader, market.baseSymbol);
  if (market.kind === "spot") {
    if (side === "buy") {
      const cost = quantity * price + fee;
      quote.total -= cost;
      quote.available -= cost;
      base.total += quantity;
      base.available += quantity;
    } else {
      const proceeds = quantity * price - fee;
      quote.total += proceeds;
      quote.available += proceeds;
      base.total -= quantity;
      base.available -= quantity;
    }
  } else {
    quote.total -= fee;
    quote.available -= fee;
    const existing = trader.positions.get(market.id);
    if (!existing || existing.side === side) {
      const priorQty = existing?.quantity ?? 0;
      const priorEntry = existing?.entryPrice ?? price;
      const newQty = priorQty + quantity;
      const newEntry = (priorEntry * priorQty + price * quantity) / newQty;
      trader.positions.set(market.id, {
        market: market.id,
        side,
        quantity: newQty,
        entryPrice: newEntry,
        leverage,
      });
    } else {
      const remaining = existing.quantity - quantity;
      if (remaining > 0) {
        trader.positions.set(market.id, { ...existing, quantity: remaining });
      } else {
        trader.positions.delete(market.id);
      }
    }
  }
  const fillId = nextFillId();
  const ownFill: OwnFill = {
    fillId,
    orderId,
    clientTag,
    market: market.id,
    side,
    price: round(price, market.priceDecimals),
    quantity: round(quantity, market.sizeDecimals),
    fee: round(fee, 2),
    time: Date.now(),
  };
  trader.ownFills.unshift(ownFill);
  const state = marketStates.get(market.id)!;
  state.sequence += 1;
  const publicFill: PublicFill = {
    market: market.id,
    price: ownFill.price,
    size: ownFill.quantity,
    takerSide: side,
    time: ownFill.time,
    sequence: state.sequence,
    tag: clientTag,
  };
  state.tape.unshift(publicFill);
  state.tape = state.tape.slice(0, 200);
  broadcast({ type: "fill", market: market.id, fill: publicFill });
}

function placeOrder(body: Record<string, unknown>) {
  const market = MARKETS.find((item) => item.id === body.market);
  if (!market) return { httpStatus: 400, body: { error: "unknown market" } };
  const address = String(body.address);
  const trader = getTrader(address);
  const state = marketStates.get(market.id)!;
  const side = body.side as "buy" | "sell";
  const orderType = body.orderType as "market" | "limit";
  const quantity = Number(body.quantity);
  const limitPrice = body.limitPrice ? Number(body.limitPrice) : null;
  const leverage = Number(body.leverage ?? 1);
  const effectivePrice = orderType === "market" ? state.markPrice : (limitPrice ?? state.markPrice);
  const notional = quantity * effectivePrice;
  const fee = (notional * market.takerFeeBps) / 10_000;
  const marginNeeded = market.kind === "perp" ? notional / Math.max(leverage, 1) : notional;
  const quoteBalance = getBalance(trader, market.quoteSymbol);

  orderSeq += 1;
  recordLatency();

  if (side === "buy" && marginNeeded + fee > quoteBalance.available) {
    return {
      httpStatus: 200,
      body: {
        orderId: nextOrderId(),
        clientOrderId: body.clientOrderId,
        status: "rejected",
        reason: "Insufficient test balance for this order.",
        confirmedAt: Date.now(),
      },
    };
  }

  const willFillNow =
    orderType === "market" ||
    (limitPrice !== null &&
      (side === "buy" ? limitPrice >= state.markPrice : limitPrice <= state.markPrice));

  const orderId = nextOrderId();

  if (!willFillNow) {
    quoteBalance.available -= marginNeeded + fee;
    trader.openOrders.set(orderId, {
      orderId,
      clientOrderId: String(body.clientOrderId),
      clientTag: String(body.clientTag),
      market: market.id,
      side,
      orderType,
      quantity: String(body.quantity),
      filledQuantity: "0",
      limitPrice: limitPrice !== null ? String(body.limitPrice) : null,
      status: "resting",
      placedAt: Date.now(),
      reduceOnly: Boolean(body.reduceOnly),
    });
    return {
      httpStatus: 200,
      body: {
        orderId,
        clientOrderId: body.clientOrderId,
        status: "accepted",
        confirmedAt: Date.now(),
      },
    };
  }

  fillSeq += 1;
  recordFill({
    market,
    trader,
    address,
    orderId,
    clientTag: String(body.clientTag),
    side,
    quantity,
    price: orderType === "market" ? state.markPrice : (limitPrice ?? state.markPrice),
    fee,
    leverage,
  });
  return {
    httpStatus: 200,
    body: {
      orderId,
      clientOrderId: body.clientOrderId,
      status: "accepted",
      confirmedAt: Date.now(),
    },
  };
}

function cancelAll(address: string, marketId: string) {
  const trader = getTrader(address);
  let cancelled = 0;
  for (const [orderId, order] of trader.openOrders) {
    if (order.market !== marketId) continue;
    const market = MARKETS.find((item) => item.id === marketId)!;
    const quoteBalance = getBalance(trader, market.quoteSymbol);
    const remaining = Number(order.quantity) - Number(order.filledQuantity);
    const price = order.limitPrice
      ? Number(order.limitPrice)
      : marketStates.get(marketId)!.markPrice;
    const releasedMargin = market.kind === "perp" ? (remaining * price) / 1 : remaining * price;
    quoteBalance.available += releasedMargin;
    trader.openOrders.delete(orderId);
    cancelled += 1;
  }
  return { cancelled };
}

function traderStatePayload(address: string) {
  const trader = getTrader(address);
  return {
    balances: Array.from(trader.balances.values()).map((balance) => ({
      asset: balance.asset,
      total: round(balance.total, 2),
      available: round(balance.available, 2),
    })),
    positions: Array.from(trader.positions.values()).map((position) => {
      const market = MARKETS.find((item) => item.id === position.market)!;
      return {
        market: position.market,
        side: position.side,
        quantity: round(position.quantity, market.sizeDecimals),
        entryPrice: round(position.entryPrice, market.priceDecimals),
        leverage: position.leverage,
        liquidationPrice: null,
        unrealizedPnl: null,
      };
    }),
    openOrders: Array.from(trader.openOrders.values()),
    ownFills: trader.ownFills.slice(0, 100),
  };
}

function fund(address: string) {
  const trader = getTrader(address);
  const balance = getBalance(trader, "nUSD");
  balance.total += 5000;
  balance.available += 5000;
  trader.funded = true;
  return { amount: "5000", reference: `fund-${address.slice(0, 8)}-${Date.now()}` };
}

function aggregateCandles(oneMinute: MarketState["candles1m"], minutesPerCandle: number) {
  const result: {
    startTime: number;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
  }[] = [];
  for (let i = 0; i < oneMinute.length; i += minutesPerCandle) {
    const chunk = oneMinute.slice(i, i + minutesPerCandle);
    if (chunk.length === 0) continue;
    const open = chunk[0].open;
    const close = chunk[chunk.length - 1].close;
    const high = Math.max(...chunk.map((c) => c.high));
    const low = Math.min(...chunk.map((c) => c.low));
    const volume = chunk.reduce((sum, c) => sum + c.volume, 0);
    result.push({
      startTime: chunk[0].startTime,
      open: round(open, 2),
      high: round(high, 2),
      low: round(low, 2),
      close: round(close, 2),
      volume: round(volume, 2),
    });
  }
  return result;
}

function candlesPayload(marketId: string, interval: string, limit: number) {
  const state = marketStates.get(marketId);
  if (!state) return [];
  const perCandle = interval === "1m" ? 1 : interval === "5m" ? 5 : interval === "15m" ? 15 : 60;
  return aggregateCandles(state.candles1m, perCandle).slice(-limit);
}

function tapePayload(marketId: string, limit: number) {
  const state = marketStates.get(marketId);
  if (!state) return [];
  return state.tape.slice(0, limit);
}

function send(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, accept",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(payload);
}

async function readJsonBody(
  req: import("node:http").IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    send(res, 204, {});
    return;
  }

  if (req.method === "GET" && path === "/v1/health") {
    send(res, 200, { ok: true, venue: "memory", network: "devnet" });
    return;
  }

  if (req.method === "GET" && path === "/v1/markets") {
    send(res, 200, MARKETS.map(marketInfoPayload));
    return;
  }

  if (req.method === "GET" && path === "/v1/tape") {
    const market = url.searchParams.get("market") ?? "";
    const limit = Number(url.searchParams.get("limit") ?? "100");
    send(res, 200, tapePayload(market, limit));
    return;
  }

  if (req.method === "GET" && path === "/v1/candles") {
    const market = url.searchParams.get("market") ?? "";
    const interval = url.searchParams.get("interval") ?? "1m";
    const limit = Number(url.searchParams.get("limit") ?? "200");
    send(res, 200, candlesPayload(market, interval, limit));
    return;
  }

  if (req.method === "GET" && path === "/v1/stats") {
    send(res, 200, statsSnapshot());
    return;
  }

  if (req.method === "GET" && path === "/v1/dev/trader") {
    const address = url.searchParams.get("address") ?? "";
    send(res, 200, traderStatePayload(address));
    return;
  }

  if (req.method === "POST" && path === "/v1/fund") {
    void readJsonBody(req).then((body) => {
      send(res, 200, fund(String(body.address)));
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
    for (const socket of sockets) socket.close();
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
wss.on("connection", (socket) => {
  if (wsBlocked) {
    socket.close();
    return;
  }
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

const TICK_MS = 1000;
setInterval(() => {
  if (wsBlocked) return;
  const now = Date.now();
  for (const market of MARKETS) {
    const state = marketStates.get(market.id)!;
    state.markPrice = Math.max(0.01, state.markPrice * (1 + (Math.random() - 0.5) * 0.003));
    state.markPriceUpdatedAt = now;
    broadcast({
      type: "price",
      market: market.id,
      price: round(state.markPrice, market.priceDecimals),
      time: now,
    });

    const lastCandle = state.candles1m[state.candles1m.length - 1];
    const candleStart = Math.floor(now / 60_000) * 60_000;
    if (lastCandle && lastCandle.startTime === candleStart) {
      lastCandle.close = state.markPrice;
      lastCandle.high = Math.max(lastCandle.high, state.markPrice);
      lastCandle.low = Math.min(lastCandle.low, state.markPrice);
    } else {
      state.candles1m.push({
        startTime: candleStart,
        open: state.markPrice,
        high: state.markPrice,
        low: state.markPrice,
        close: state.markPrice,
        volume: 1,
      });
      if (state.candles1m.length > 500) state.candles1m.shift();
    }
    broadcast({
      type: "candle",
      market: market.id,
      interval: "1m",
      candle: {
        startTime: candleStart,
        open: round(lastCandle?.open ?? state.markPrice, market.priceDecimals),
        high: round(lastCandle?.high ?? state.markPrice, market.priceDecimals),
        low: round(lastCandle?.low ?? state.markPrice, market.priceDecimals),
        close: round(state.markPrice, market.priceDecimals),
        volume: round(lastCandle?.volume ?? 1, 2),
      },
    });
  }
  broadcast({ type: "stats", stats: statsSnapshot() });
}, TICK_MS);

resetState();

const port = Number(process.argv[2] ?? process.env.FAKE_SIM_PORT ?? 4200);
server.listen(port, () => {
  console.log(`Fake sim-noirwire listening on ${port}`);
});
