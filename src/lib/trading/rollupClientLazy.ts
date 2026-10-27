import type { Connection } from "@solana/web3.js";
import type { UnknownHold } from "../rollup/accountMemory";
import type { DeploymentOverrides, PublicDeployment } from "../rollup/deployment";
import type {
  AccountStatus,
  CancelResult,
  FundOutcome,
  KeyWithdrawal,
  MarketLimits,
  MarketSettingsLookup,
  NewOrderInput,
  OpenAccountOutcome,
  OrderKeyState,
  OwnerAuth,
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

  private ready: TradingClient | null = null;

  private load(): Promise<TradingClient> {
    if (!this.loaded) {
      this.loaded = import("./rollupClient").then(({ RollupTradingClient }) => {
        const client = new RollupTradingClient({
          simUrl: this.options.simUrl,
          overrides: this.options.overrides,
          marketSettingsLookup: this.options.marketSettingsLookup,
        });
        this.ready = client;
        return client;
      });
    }
    return this.loaded;
  }

  repriceState(wallet: WalletIdentity): TraderState | null {
    return this.ready?.repriceState?.(wallet) ?? null;
  }

  async openAccount(wallet: WalletIdentity, invite?: string): Promise<OpenAccountOutcome> {
    return (await this.load()).openAccount(wallet, invite);
  }

  async rollupReader(wallet: WalletIdentity): Promise<Connection> {
    const client = await this.load();
    if (!client.rollupReader)
      throw new Error("This client has no rollup connection to read through");
    return client.rollupReader(wallet);
  }

  async ownerAuth(): Promise<OwnerAuth> {
    return (await (await this.load()).ownerAuth?.()) ?? "transaction";
  }

  async withdrawByKey(
    wallet: WalletIdentity,
    atoms: bigint,
    onSigned?: (raw: Uint8Array) => Promise<void>,
  ): Promise<KeyWithdrawal> {
    const client = await this.load();
    if (!client.withdrawByKey) throw new Error("This client cannot withdraw by order key");
    return client.withdrawByKey(wallet, atoms, onSigned);
  }

  async accountStatus(
    wallet: WalletIdentity,
    options?: { fresh?: boolean },
  ): Promise<AccountStatus> {
    return (await (await this.load()).accountStatus?.(wallet, options)) ?? "unknown";
  }

  async makersListedMarkets(wallet: WalletIdentity): Promise<ReadonlySet<string>> {
    return (await (await this.load()).makersListedMarkets?.(wallet)) ?? new Set();
  }

  async marketLimits(wallet: WalletIdentity): Promise<ReadonlyMap<string, MarketLimits>> {
    return (await (await this.load()).marketLimits?.(wallet)) ?? new Map();
  }

  async sessionDeployment(wallet: WalletIdentity): Promise<PublicDeployment> {
    const client = await this.load();
    if (!client.sessionDeployment) throw new Error("This client has no session deployment");
    return client.sessionDeployment(wallet);
  }

  subscribeOrderKeys(wallet: WalletIdentity, listener: (state: OrderKeyState) => void): () => void {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    void this.load().then((client) => {
      if (!cancelled) unsubscribe = client.subscribeOrderKeys?.(wallet, listener) ?? null;
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }

  async fund(wallet: WalletIdentity): Promise<FundOutcome> {
    return (await this.load()).fund(wallet);
  }

  async knownNoFaucet(): Promise<boolean> {
    return (await (await this.load()).knownNoFaucet?.()) ?? false;
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

  releaseUnknownOutcome(wallet: WalletIdentity, market: string, tag?: string): void {
    if (!this.loaded) return;
    void this.loaded.then((client) => client.releaseUnknownOutcome?.(wallet, market, tag));
  }

  async readUnknownOutcome(wallet: WalletIdentity, market: string): Promise<UnknownHold | null> {
    return (await (await this.load()).readUnknownOutcome?.(wallet, market)) ?? null;
  }

  closeWallet(wallet: WalletIdentity): void {
    // Only closes a session that was actually opened; never forces the
    // on-chain SDK to load just to close nothing.
    if (!this.loaded) return;
    void this.loaded.then((client) => client.closeWallet?.(wallet));
  }

  subscribe(
    wallet: WalletIdentity,
    listener: (state: TraderState) => void,
    onError?: (error: Error) => void,
  ): () => void {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    this.load().then(
      (client) => {
        if (cancelled) return;
        unsubscribe = client.subscribe(wallet, listener, onError);
      },
      (error: unknown) => {
        if (!cancelled) onError?.(error instanceof Error ? error : new Error(String(error)));
      },
    );
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }
}
