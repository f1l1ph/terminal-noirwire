import { z } from "zod";

/**
 * `GET /v1/deployment` (sim-noirwire, rollup mode only): everything a
 * browser needs to trade on the real program directly, built field by
 * field from what is public on chain. Replaces the on-chain account scan
 * this terminal used before that route existed, and the three
 * `NEXT_PUBLIC_ROLLUP_*` URLs as the primary source - those env vars still
 * work as overrides (a container or a hosted deployment reaching the
 * network at a different address than the browser can), applied after the
 * fetch, never instead of it.
 */
const tokenSchema = z.object({
  symbol: z.string(),
  mint: z.string(),
  decimals: z.number().int().nonnegative(),
});

const marketSchema = z.object({
  marketId: z.number().int().nonnegative(),
  symbol: z.string(),
  kind: z.enum(["spot", "perp"]),
  market: z.string(),
  tape: z.string(),
  priceFeed: z.string(),
  baseToken: tokenSchema.nullable(),
  quoteToken: tokenSchema,
  baseDecimals: z.number().int().nonnegative(),
  quoteDecimals: z.number().int().nonnegative(),
  lotSize: z.string(),
  tick: z.string(),
});

export const deploymentSchema = z.object({
  network: z.string(),
  programId: z.string(),
  solanaRpcUrl: z.string(),
  rollupRpcUrl: z.string(),
  rollupWsUrl: z.string(),
  exchange: z.string(),
  stats: z.string(),
  markets: z.array(marketSchema),
});

export type PublicDeployment = z.infer<typeof deploymentSchema>;
export type PublicMarket = z.infer<typeof marketSchema>;

export interface DeploymentOverrides {
  rollupRpcUrl?: string;
  rollupWsUrl?: string;
  programId?: string;
}

const cache = new Map<string, Promise<PublicDeployment>>();

export function fetchDeployment(
  simUrl: string,
  overrides: DeploymentOverrides = {},
  fetchFn: typeof fetch = fetch,
): Promise<PublicDeployment> {
  const existing = cache.get(simUrl);
  if (existing) return existing;
  const promise = load(simUrl, overrides, fetchFn);
  cache.set(simUrl, promise);
  return promise;
}

async function load(
  simUrl: string,
  overrides: DeploymentOverrides,
  fetchFn: typeof fetch,
): Promise<PublicDeployment> {
  const response = await fetchFn(`${simUrl}/v1/deployment`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`${simUrl}/v1/deployment answered ${response.status}`);
  }
  const parsed = deploymentSchema.parse(await response.json());
  return {
    ...parsed,
    rollupRpcUrl: overrides.rollupRpcUrl ?? parsed.rollupRpcUrl,
    rollupWsUrl: overrides.rollupWsUrl ?? parsed.rollupWsUrl,
    programId: overrides.programId ?? parsed.programId,
  };
}

export function marketBySymbol(
  deployment: PublicDeployment,
  symbol: string,
): PublicMarket | undefined {
  return deployment.markets.find((market) => market.symbol === symbol);
}
