export interface MainnetConfig {
  tradingMode: string;
  allowUnsignedDev: string | undefined;
  networkLabel: string;
  programIdOverride: string | undefined;
  rollupRpcUrlOverride: string | undefined;
  rollupWsUrlOverride: string | undefined;
}

/**
 * Everything a mainnet build refuses to start with: unsigned dev mode, a
 * label other than MAINNET, and any program or rollup address
 * other than the pinned one. An unset override is fine; the pin applies.
 */
export function mainnetRefusals(
  config: MainnetConfig,
  pins: { programId: string; rollupRpcUrl: string; rollupWsUrl: string },
): string[] {
  const refusals: string[] = [];
  if (config.tradingMode !== "rollup") {
    refusals.push("NEXT_PUBLIC_NETWORK=mainnet requires NEXT_PUBLIC_TRADING_MODE=rollup.");
  }
  if (config.allowUnsignedDev) {
    refusals.push("NEXT_PUBLIC_NETWORK=mainnet refuses NEXT_PUBLIC_ALLOW_UNSIGNED_DEV_MODE.");
  }
  if (config.networkLabel !== "MAINNET") {
    refusals.push(
      'NEXT_PUBLIC_NETWORK=mainnet requires NEXT_PUBLIC_NETWORK_LABEL unset or "MAINNET".',
    );
  }
  const overrides = [
    ["NEXT_PUBLIC_ORDERBOOK_PROGRAM_ID", config.programIdOverride, pins.programId],
    ["NEXT_PUBLIC_ROLLUP_RPC_URL", config.rollupRpcUrlOverride, pins.rollupRpcUrl],
    ["NEXT_PUBLIC_ROLLUP_WS_URL", config.rollupWsUrlOverride, pins.rollupWsUrl],
  ] as const;
  for (const [name, value, pinned] of overrides) {
    if (value !== undefined && value !== pinned) {
      refusals.push(`${name} must be unset or exactly ${pinned} on mainnet.`);
    }
  }
  return refusals;
}

/**
 * Dev mode posts orders with only an address and no signature, so a
 * production build refuses it unless the build explicitly opts in (the
 * end-to-end suites build against a mock service this way).
 */
export function unsignedDevModeRefusal(
  tradingMode: string,
  nodeEnv: string | undefined,
  allowUnsignedDev: string | undefined,
): string | null {
  if (tradingMode !== "dev" || nodeEnv !== "production" || allowUnsignedDev === "1") return null;
  return "NEXT_PUBLIC_TRADING_MODE=dev posts unsigned orders and is refused in a production build. Use rollup mode.";
}
