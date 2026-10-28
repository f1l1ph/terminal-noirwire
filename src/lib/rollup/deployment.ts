import { z } from "zod";
import { keepLastKnown, loadLastKnown } from "../lastKnown";
import { browserLocalStorage, type KeyValueStore } from "../wallet/index";
import { pinRefusal, testBuildRefusal, type NetworkPins } from "./pins";

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
  /**
   * How the owner consents to opening an account, replacing order keys and
   * (through an order key) withdrawing: with a signed message, or with a
   * transaction their wallet signs. Absent means "transaction", which is also
   * what a deployment whose program predates signed messages must say.
   */
  ownerAuth: z.enum(["message", "transaction"]).optional(),
});

export type PublicDeployment = z.infer<typeof deploymentSchema>;

/** Whether the deployment's program takes the owner's consent as a signed message. Anything but an explicit "message" is the transaction path. */
export const usesOwnerMessages = (deployment: Pick<PublicDeployment, "ownerAuth">): boolean =>
  deployment.ownerAuth === "message";

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
  /**
   * Set on a mainnet build only. The answer is refused unless it agrees with
   * these pins, and the pinned rollup URLs replace whatever it names.
   */
  pins?: NetworkPins;
}

const cache = new Map<string, Promise<Loaded>>();

const KEPT_NAME = "deployment";

/** Drops the description cached for the page's life, so the next `fetchDeployment` asks the service again. */
export function forgetDeployment(simUrl: string): void {
  cache.delete(simUrl);
}

interface Loaded {
  deployment: PublicDeployment;
  /** True when the service could not be reached and the description is the one this browser kept. */
  kept: boolean;
  /** The live description was accepted by this build's checks and has been kept for the next visit. */
  stored?: boolean;
}

/**
 * One fetch per service for the life of the page. The pin checks and the URL
 * overrides run on every call, after the cache, so no caller can be handed an
 * answer another caller's pins would have refused. A failed fetch is
 * forgotten as soon as it fails, so the next caller asks again instead of
 * inheriting a network blip until the page is reloaded. When the service
 * cannot be reached, the last description this browser kept stands in for it
 * (and is not cached, so the next caller asks the service again); every live
 * answer replaces the kept one.
 */
export async function fetchDeployment(
  simUrl: string,
  overrides: DeploymentOverrides = {},
  fetchFn: typeof fetch = fetch,
  sleep?: (ms: number) => Promise<void>,
  storage: KeyValueStore = browserLocalStorage(),
): Promise<PublicDeployment> {
  let promise = cache.get(simUrl);
  if (!promise) {
    promise = loadOrKept(simUrl, fetchFn, sleep, storage);
    cache.set(simUrl, promise);
    const loading = promise;
    loading.then(
      ({ kept }) => {
        if (kept && cache.get(simUrl) === loading) cache.delete(simUrl);
      },
      () => {
        if (cache.get(simUrl) === loading) cache.delete(simUrl);
      },
    );
  }
  try {
    const loaded = await promise;
    const result = accepted(simUrl, loaded.deployment, overrides);
    if (!loaded.kept && !loaded.stored) {
      loaded.stored = keepLastKnown(storage, KEPT_NAME, simUrl, loaded.deployment);
    }
    return result;
  } catch (error) {
    if (cache.get(simUrl) === promise) cache.delete(simUrl);
    throw error;
  }
}

function accepted(
  simUrl: string,
  parsed: PublicDeployment,
  overrides: DeploymentOverrides,
): PublicDeployment {
  const { pins } = overrides;
  const refusal = pins ? pinRefusal(pins, parsed) : testBuildRefusal(parsed);
  if (refusal) throw new Error(`${simUrl}/v1/deployment refused: ${refusal}`);
  return {
    ...parsed,
    markets: pins
      ? parsed.markets.filter((market) => pins.marketIds.includes(market.marketId))
      : parsed.markets,
    rollupRpcUrl: pins?.rollupRpcUrl ?? overrides.rollupRpcUrl ?? parsed.rollupRpcUrl,
    rollupWsUrl: pins?.rollupWsUrl ?? overrides.rollupWsUrl ?? parsed.rollupWsUrl,
  };
}

const LOAD_ATTEMPTS = 3;
const LOAD_FIRST_WAIT_MS = 1_000;

/** A service that is busy or unreachable may answer on the next try; a refusal or a malformed answer will not change. */
class TransientLoadError extends Error {}

async function loadOnce(simUrl: string, fetchFn: typeof fetch): Promise<PublicDeployment> {
  let response: Response;
  try {
    response = await fetchFn(`${simUrl}/v1/deployment`, {
      headers: { accept: "application/json" },
    });
  } catch (error) {
    throw new TransientLoadError(error instanceof Error ? error.message : "the request failed");
  }
  if (!response.ok) {
    const message = `${simUrl}/v1/deployment answered ${response.status}`;
    throw response.status >= 500 || response.status === 429
      ? new TransientLoadError(message)
      : new Error(message);
  }
  return deploymentSchema.parse(await response.json());
}

/** The live description (kept for next time once this build accepts it), or, when the service stays unreachable or busy, the one kept from an earlier visit. A refusal or a malformed answer is never covered over. */
async function loadOrKept(
  simUrl: string,
  fetchFn: typeof fetch,
  sleep: ((ms: number) => Promise<void>) | undefined,
  storage: KeyValueStore,
): Promise<Loaded> {
  try {
    const deployment = await load(simUrl, fetchFn, sleep);
    return { deployment, kept: false };
  } catch (error) {
    if (!(error instanceof TransientLoadError)) throw error;
    const deployment = loadLastKnown(storage, KEPT_NAME, simUrl, deploymentSchema);
    if (!deployment) throw error;
    return { deployment, kept: true };
  }
}

/** Asks up to three times, waiting 1 s then 2 s, so a blip in the service does not stop a session from being built. */
async function load(
  simUrl: string,
  fetchFn: typeof fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<PublicDeployment> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await loadOnce(simUrl, fetchFn);
    } catch (error) {
      if (!(error instanceof TransientLoadError) || attempt >= LOAD_ATTEMPTS) throw error;
      await sleep(LOAD_FIRST_WAIT_MS * 2 ** (attempt - 1));
    }
  }
}
