import { PublicKey } from "@solana/web3.js";
import { env } from "../env";
import { DevTradingClient } from "./devClient";
import { RollupTradingClient } from "./rollupClient";
import type { MarketSettingsLookup, TradingClient } from "./types";

export function createTradingClient(marketSettingsLookup: MarketSettingsLookup): TradingClient {
  if (env.tradingMode === "rollup") {
    return new RollupTradingClient({
      simUrl: env.simUrl,
      rollupRpcUrl: env.rollupRpcUrl!,
      rollupWsUrl: env.rollupWsUrl!,
      rollupPrivateUrl: env.rollupPrivateUrl!,
      programId: env.orderbookProgramId ? new PublicKey(env.orderbookProgramId) : undefined,
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
export { DevTradingClient } from "./devClient";
export { RollupTradingClient } from "./rollupClient";
