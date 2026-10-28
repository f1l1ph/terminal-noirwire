export interface MainnetConfig {
  tradingMode: string;
  allowUnsignedDev: string | undefined;
  networkLabel: string;
  programIdOverride: string | undefined;
  rollupRpcUrlOverride: string | undefined;
  rollupWsUrlOverride: string | undefined;
  solanaRpcUrl: string | undefined;
}

/**
 * Why `url` cannot be the Solana RPC a mainnet build reads the cluster's
 * genesis hash from, or null when it can: an https URL with no credentials,
 * trailing slash or hash, so the one origin it names is the one the page's
 * content security policy opens. A provider key in its path or query ships in
 * the browser bundle like any key the page uses, so it must be one the
 * provider restricts to this site's origin.
 */
function solanaRpcUrlRefusal(url: string | undefined): string | null {
  if (!url) return "NEXT_PUBLIC_NETWORK=mainnet requires NEXT_PUBLIC_SOLANA_RPC_URL.";
  const problem =
    "NEXT_PUBLIC_SOLANA_RPC_URL must be an https URL with no credentials, trailing slash or hash.";
  if (!url.startsWith("https://") || url.endsWith("/") || url.includes("#")) return problem;
  try {
    const parsed = new URL(url);
    return parsed.username || parsed.password || parsed.hash ? problem : null;
  } catch {
    return problem;
  }
}

/**
 * Everything a mainnet build refuses to start with: unsigned dev mode, a
 * label other than MAINNET, any program or rollup address other than the
 * pinned one, and a missing or unsafe Solana RPC URL. An unset override is
 * fine; the pin applies.
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
  const solanaRefusal = solanaRpcUrlRefusal(config.solanaRpcUrl);
  if (solanaRefusal) refusals.push(solanaRefusal);
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
