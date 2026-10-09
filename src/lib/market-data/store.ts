import type { ConnectionState } from "./socket";
import type {
  Candle,
  CandleInterval,
  MarketInfo,
  PublicFill,
  VenueStats,
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
  stats: VenueStats | null;
  connectionState: ConnectionState;
}

function emptyState(): MarketDataState {
  return {
    markets: [],
    marksByMarket: {},
    tapeByMarket: {},
    candlesByMarket: {},
    stats: null,
    connectionState: "closed",
  };
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
      const existing = marksByMarket[market.id];
      if (!existing || market.markPriceUpdatedAt >= existing.time) {
        marksByMarket[market.id] = { price: market.markPrice, time: market.markPriceUpdatedAt };
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

  setConnectionState(connectionState: ConnectionState): void {
    if (this.state.connectionState === connectionState) return;
    this.setState({ connectionState });
  }

  applyMessage(message: WsMessage): void {
    switch (message.type) {
      case "price":
        this.applyPrice(message.market, message.price, message.time);
        return;
      case "fill":
        this.applyFill(message.market, message.fill);
        return;
      case "candle":
        this.applyCandle(message.market, message.interval, message.candle);
        return;
      case "stats":
        this.setState({ stats: message.stats });
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
      last && last.startTime === candle.startTime
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
