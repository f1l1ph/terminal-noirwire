import { env } from "../env";
import { DevTradingClient } from "./devClient";
import { LazyRollupTradingClient } from "./rollupClientLazy";
import type { MarketSettingsLookup, TradingClient } from "./types";

export function createTradingClient(marketSettingsLookup: MarketSettingsLookup): TradingClient {
  if (env.tradingMode === "rollup") {
    return new LazyRollupTradingClient({
      simUrl: env.simUrl,
      overrides: {
        rollupRpcUrl: env.rollupRpcUrlOverride,
        rollupWsUrl: env.rollupWsUrlOverride,
        programId: env.orderbookProgramIdOverride,
      },
      marketSettingsLookup,
    });
  }
  return new DevTradingClient({ baseUrl: env.simUrl });
}

export * from "./types";
export * from "./decimal";
export * from "./risk";
export * from "./validation";
export * from "./tags";
export * from "./spotTransfer";
export { DevTradingClient } from "./devClient";
