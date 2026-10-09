import type { ConnectionState } from "./socket";
import type {
  Candle,
  CandleInterval,
  MarketInfo,
  PublicFill,
  StatsResponse,
  WsMessage,
} from "./types";

const MAX_TAPE_ROWS = 200;
const MAX_CANDLES = 300;

export interface MarkInfo {
  price: string;
  time: number;
}

export interface MarketDataState {
  markets: MarketInfo[];
  marksByMarket: Record<string, MarkInfo>;
  tapeByMarket: Record<string, PublicFill[]>;
  candlesByMarket: Record<string, Partial<Record<CandleInterval, Candle[]>>>;
  /** True from the moment a (market, interval) candle fetch starts until it settles, so the chart can show an honest "Loading" state instead of a shell with nothing in it. */
  candlesLoading: Record<string, boolean>;
  stats: StatsResponse | null;
  connectionState: ConnectionState;
}

function emptyState(): MarketDataState {
  return {
    markets: [],
    marksByMarket: {},
    tapeByMarket: {},
    candlesByMarket: {},
    candlesLoading: {},
    stats: null,
    connectionState: "closed",
  };
}

function candlesLoadingKey(market: string, interval: CandleInterval): string {
  return `${market}:${interval}`;
}

/**
 * Plain, framework-free state for everything the simulation service
 * publishes. A React hook wraps this with `useSyncExternalStore`; the store
 * itself is unit-testable with no React involved.
 */
export class MarketDataStore {
  private state: MarketDataState = emptyState();
  private readonly listeners = new Set<() => void>();

  getState(): MarketDataState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setMarkets(markets: MarketInfo[]): void {
    const marksByMarket = { ...this.state.marksByMarket };
    for (const market of markets) {
      if (market.markPrice === null || market.markPriceUpdatedAtMs === null) continue;
      const existing = marksByMarket[market.id];
      if (!existing || market.markPriceUpdatedAtMs >= existing.time) {
        marksByMarket[market.id] = { price: market.markPrice, time: market.markPriceUpdatedAtMs };
      }
    }
    this.setState({ markets, marksByMarket });
  }

  setInitialTape(market: string, fills: PublicFill[]): void {
    this.setState({
      tapeByMarket: { ...this.state.tapeByMarket, [market]: fills.slice(0, MAX_TAPE_ROWS) },
    });
  }

  setInitialCandles(market: string, interval: CandleInterval, candles: Candle[]): void {
    const forMarket = { ...(this.state.candlesByMarket[market] ?? {}) };
    forMarket[interval] = candles.slice(-MAX_CANDLES);
    this.setState({
      candlesByMarket: { ...this.state.candlesByMarket, [market]: forMarket },
    });
  }

  setCandlesLoading(market: string, interval: CandleInterval, loading: boolean): void {
    const key = candlesLoadingKey(market, interval);
    if (this.state.candlesLoading[key] === loading) return;
    this.setState({ candlesLoading: { ...this.state.candlesLoading, [key]: loading } });
  }

  /** The REST `/v1/stats` shape (groups by metric, carries `network`); the websocket's `stats` message has a different shape (groups by user/bot) and goes through `applyMessage` instead. */
  setStats(stats: StatsResponse): void {
    this.setState({ stats });
  }

  setConnectionState(connectionState: ConnectionState): void {
    if (this.state.connectionState === connectionState) return;
    this.setState({ connectionState });
  }

  applyMessage(message: WsMessage): void {
    switch (message.type) {
      case "price":
        this.applyPrice(message.market, message.price, message.publishedAtMs);
        return;
      case "fill":
        this.applyFill(message.market, {
          market: message.market,
          price: message.price,
          size: message.size,
          takerSide: message.takerSide,
          takerTag: message.takerTag,
          makerTag: message.makerTag,
          timestampMs: message.timestampMs,
          sequence: message.sequence,
        });
        return;
      case "candle":
        this.applyCandle(message.market, message.interval, message.candle);
        return;
      case "stats":
        this.setState({
          stats: {
            network: this.state.stats?.network ?? "",
            orders: { user: message.stats.user.orders, bot: message.stats.bot.orders },
            fills: { user: message.stats.user.fills, bot: message.stats.bot.fills },
            volume: { user: message.stats.user.volume, bot: message.stats.bot.volume },
            tradersTotal: message.stats.tradersTotal,
            latency: message.stats.latency,
            updatedAtMs: message.stats.updatedAtMs,
          },
        });
        return;
    }
  }

  private applyPrice(market: string, price: string, time: number): void {
    const existing = this.state.marksByMarket[market];
    if (existing && time < existing.time) return;
    this.setState({
      marksByMarket: { ...this.state.marksByMarket, [market]: { price, time } },
    });
  }

  private applyFill(market: string, fill: PublicFill): void {
    const existing = this.state.tapeByMarket[market] ?? [];
    const next = [fill, ...existing].slice(0, MAX_TAPE_ROWS);
    this.setState({ tapeByMarket: { ...this.state.tapeByMarket, [market]: next } });
  }

  private applyCandle(market: string, interval: CandleInterval, candle: Candle): void {
    const forMarket = { ...(this.state.candlesByMarket[market] ?? {}) };
    const existing = forMarket[interval] ?? [];
    const last = existing[existing.length - 1];
    const next =
      last && last.startMs === candle.startMs
        ? [...existing.slice(0, -1), candle]
        : [...existing, candle].slice(-MAX_CANDLES);
    forMarket[interval] = next;
    this.setState({ candlesByMarket: { ...this.state.candlesByMarket, [market]: forMarket } });
  }

  private setState(patch: Partial<MarketDataState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
