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

/**
 * The quote token `marketId` is priced in, as the deployment names it. With
 * no market id, or one the deployment does not list, the first perpetual's:
 * its quote token is the collateral every perpetual shares. Null when the
 * deployment lists no market at all.
 */
export function quoteSymbolOf(deployment: PublicDeployment, marketId?: string): string | null {
  const market =
    deployment.markets.find((entry) => entry.symbol === marketId) ??
    deployment.markets.find((entry) => entry.kind === "perp") ??
    deployment.markets[0];
  return market?.quoteToken.symbol ?? null;
}

export interface DeploymentOverrides {
  rollupRpcUrl?: string;
  rollupWsUrl?: string;
  /**
   * The program this build trades on (`trustedProgramId`). Never written
   * over the description's own `programId`, so a service naming another
   * program is still caught by the comparison in `buildRealSession`.
   */
  programId?: string;
}

const cache = new Map<string, Promise<PublicDeployment>>();

/**
 * One fetch per service and set of overrides for the life of the page. A
 * failed fetch is forgotten as soon as it fails, so the next caller asks
 * again instead of inheriting a network blip until the page is reloaded.
 */
export function fetchDeployment(
  simUrl: string,
  overrides: DeploymentOverrides = {},
  fetchFn: typeof fetch = fetch,
): Promise<PublicDeployment> {
  const key = JSON.stringify([simUrl, overrides.rollupRpcUrl, overrides.rollupWsUrl]);
  const existing = cache.get(key);
  if (existing) return existing;
  const promise = load(simUrl, overrides, fetchFn);
  cache.set(key, promise);
  promise.catch(() => {
    if (cache.get(key) === promise) cache.delete(key);
  });
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
  };
}
