import { env } from "../env";
import type { DeploymentOverrides } from "../rollup/deployment";
import { MAINNET_PINS } from "../rollup/pins";
import { DevTradingClient } from "./devClient";
import { LazyRollupTradingClient } from "./rollupClientLazy";
import type { MarketSettingsLookup, TradingClient } from "./types";

/** What every reader of `/v1/deployment` in this build passes, so none of them sees an answer another would refuse. */
export const deploymentOverrides: DeploymentOverrides = {
  rollupRpcUrl: env.rollupRpcUrlOverride,
  rollupWsUrl: env.rollupWsUrlOverride,
  programId: env.orderbookProgramIdOverride,
  pins: env.network === "mainnet" ? MAINNET_PINS : undefined,
};

export function createTradingClient(marketSettingsLookup: MarketSettingsLookup): TradingClient {
  if (env.tradingMode === "rollup") {
    return new LazyRollupTradingClient({
      simUrl: env.simUrl,
      overrides: deploymentOverrides,
      marketSettingsLookup,
    });
  }
  return new DevTradingClient({ baseUrl: env.simUrl });
}
