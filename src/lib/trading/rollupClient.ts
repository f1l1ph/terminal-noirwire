import type {
  CancelResult,
  FundResult,
  NewOrderInput,
  PlaceOrderResult,
  TraderState,
  TradingClient,
  WalletIdentity,
} from "./types";

const NOT_CONNECTED = "The rollup trading client is not connected yet.";

/**
 * Placeholder for the implementation that signs transactions and sends them
 * to the rollup directly. Selected by NEXT_PUBLIC_TRADING_MODE=rollup. Every
 * method rejects; the terminal shell checks `mode === "rollup"` and renders
 * a plain "not connected" state rather than calling these.
 */
export class NotConnectedRollupTradingClient implements TradingClient {
  readonly mode = "rollup" as const;

  async openAccount(_wallet: WalletIdentity): Promise<void> {
    throw new Error(NOT_CONNECTED);
  }

  async fund(_wallet: WalletIdentity): Promise<FundResult> {
    throw new Error(NOT_CONNECTED);
  }

  async placeOrder(_wallet: WalletIdentity, _order: NewOrderInput): Promise<PlaceOrderResult> {
    throw new Error(NOT_CONNECTED);
  }

  async cancelOrder(
    _wallet: WalletIdentity,
    _market: string,
    _orderId: string,
  ): Promise<CancelResult> {
    throw new Error(NOT_CONNECTED);
  }

  async cancelAll(_wallet: WalletIdentity, _market: string): Promise<CancelResult> {
    throw new Error(NOT_CONNECTED);
  }

  async fetchState(_wallet: WalletIdentity): Promise<TraderState> {
    throw new Error(NOT_CONNECTED);
  }

  subscribe(_wallet: WalletIdentity, _listener: (state: TraderState) => void): () => void {
    return () => {};
  }
}
