import { env } from "../env";
import { DevTradingClient } from "./devClient";
import { NotConnectedRollupTradingClient } from "./rollupClient";
import type { TradingClient } from "./types";

export function createTradingClient(): TradingClient {
  if (env.tradingMode === "rollup") {
    return new NotConnectedRollupTradingClient();
  }
  return new DevTradingClient({ baseUrl: env.simUrl });
}

export * from "./types";
export * from "./decimal";
export * from "./risk";
export * from "./validation";
export * from "./tags";
export { DevTradingClient } from "./devClient";
export { NotConnectedRollupTradingClient } from "./rollupClient";
