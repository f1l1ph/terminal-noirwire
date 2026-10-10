import type { DeploymentOverrides } from "../rollup/deployment";
import type {
  CancelResult,
  FundOutcome,
  MarketSettingsLookup,
  NewOrderInput,
  PlaceOrderResult,
  PrivacyCheck,
  TraderState,
  TradingClient,
  TransferResult,
  WalletIdentity,
} from "./types";

export interface LazyRollupOptions {
  simUrl: string;
  overrides?: DeploymentOverrides;
  marketSettingsLookup: MarketSettingsLookup;
}

/**
 * Loads `RollupTradingClient` - and so `@noirwire/orderbook` and everything
 * under it - only when this client is actually used, via a dynamic
 * `import()`. A static `import` here would put the whole on-chain SDK in
 * every build's bundle regardless of trading mode, because
 * `env.tradingMode` is a property read off a parsed object rather than the
 * literal `process.env.NEXT_PUBLIC_TRADING_MODE` expression Next.js's
 * dead-code elimination needs to see directly - confirmed by measuring a
 * dev-mode build before this existed (see docs/BUILD-NOTES.md). The
 * dynamic import is a separate chunk regardless, so dev mode never fetches
 * it.
 */
export class LazyRollupTradingClient implements TradingClient {
  readonly mode = "rollup" as const;
  private loaded: Promise<TradingClient> | null = null;

  constructor(private readonly options: LazyRollupOptions) {}

  private load(): Promise<TradingClient> {
    if (!this.loaded) {
      this.loaded = import("./rollupClient").then(
        ({ RollupTradingClient }) =>
          new RollupTradingClient({
            simUrl: this.options.simUrl,
            overrides: this.options.overrides,
            marketSettingsLookup: this.options.marketSettingsLookup,
          }),
      );
    }
    return this.loaded;
  }

  async openAccount(wallet: WalletIdentity): Promise<void> {
    return (await this.load()).openAccount(wallet);
  }

  async fund(wallet: WalletIdentity): Promise<FundOutcome> {
    return (await this.load()).fund(wallet);
  }

  async placeOrder(wallet: WalletIdentity, order: NewOrderInput): Promise<PlaceOrderResult> {
    return (await this.load()).placeOrder(wallet, order);
  }

  async cancelAllInMarket(wallet: WalletIdentity, market: string): Promise<CancelResult> {
    return (await this.load()).cancelAllInMarket(wallet, market);
  }

  async cancelOrder(
    wallet: WalletIdentity,
    market: string,
    orderId: string,
  ): Promise<CancelResult> {
    const client = await this.load();
    if (!client.cancelOrder) throw new Error("Per-order cancel is not available");
    return client.cancelOrder(wallet, market, orderId);
  }

  async transferBetweenBalances(
    wallet: WalletIdentity,
    toSpot: boolean,
    amount: string,
  ): Promise<TransferResult> {
    const client = await this.load();
    if (!client.transferBetweenBalances) {
      return { kind: "error", message: "Transfer is not available" };
    }
    return client.transferBetweenBalances(wallet, toSpot, amount);
  }

  async syncMarket(wallet: WalletIdentity, market: string): Promise<void> {
    const client = await this.load();
    return client.syncMarket?.(wallet, market);
  }

  async checkPrivacy(wallet: WalletIdentity, market: string): Promise<PrivacyCheck> {
    const client = await this.load();
    if (!client.checkPrivacy) throw new Error("Privacy check is not available");
    return client.checkPrivacy(wallet, market);
  }

  async fetchState(wallet: WalletIdentity): Promise<TraderState> {
    return (await this.load()).fetchState(wallet);
  }

  closeWallet(wallet: WalletIdentity): void {
    // Only closes a session that was actually opened; never forces the
    // on-chain SDK to load just to close nothing.
    if (!this.loaded) return;
    void this.loaded.then((client) => client.closeWallet?.(wallet));
  }

  subscribe(wallet: WalletIdentity, listener: (state: TraderState) => void): () => void {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    void this.load().then((client) => {
      if (cancelled) return;
      unsubscribe = client.subscribe(wallet, listener);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }
}
