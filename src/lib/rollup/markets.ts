import type { PublicDeployment } from "./deployment";
import { MARKET_KIND_CODE, type decodeMarketAccount } from "./sdk";

type DeploymentMarket = PublicDeployment["markets"][number];
type ChainMarket = ReturnType<typeof decodeMarketAccount>;

/**
 * What this build knows about each market without asking anyone: the base
 * asset the market account must name, and how many decimals that asset
 * counts in. Base decimals are not on chain at all (a perpetual's base is
 * not a token), so they cannot be checked against the rollup; they are
 * pinned here instead, and a market this table does not list is not traded.
 * Mirrors the order book's own deployment description (`ops/deployment.ts`
 * in that repository).
 */
const PINNED_MARKETS: Record<string, { baseSymbol: string; baseDecimals: number }> = {
  "NSOL-PERP": { baseSymbol: "NSOL", baseDecimals: 9 },
  "NNVDA-PERP": { baseSymbol: "NNVDA", baseDecimals: 6 },
  "NSOL-NUSD": { baseSymbol: "NSOL", baseDecimals: 9 },
};

/** Every quote amount in this terminal is nUSD at 6 decimals (see units.ts). */
const QUOTE_SYMBOL = "NUSD";
const QUOTE_DECIMALS = 6;

/** The pinned base decimals of a market this build trades, or null for one it does not. */
export function pinnedBaseDecimals(symbol: string): number | null {
  return PINNED_MARKETS[symbol]?.baseDecimals ?? null;
}

const sameSymbol = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();

/**
 * Whether a `/v1/deployment` market entry says the same as the market
 * account the rollup holds at that market's address, and as this build's
 * pins: the market id the account was made for, its kind, its lot and tick,
 * its base and quote assets, and (for a spot market) the mints the
 * Exchange account registered at the account's token indices. Anything the
 * service could report differently from the chain is compared, so a wrong
 * or swapped entry cannot change how a typed size or price is signed.
 */
export function marketMatchesChain(
  market: DeploymentMarket,
  chain: ChainMarket,
  exchangeMints: readonly string[],
): boolean {
  const pinned = PINNED_MARKETS[market.symbol];
  if (!pinned) return false;
  const kind = market.kind === "perp" ? MARKET_KIND_CODE.perp : MARKET_KIND_CODE.spot;
  const quoteMatches =
    sameSymbol(chain.quoteSymbol, QUOTE_SYMBOL) &&
    sameSymbol(market.quoteToken.symbol, QUOTE_SYMBOL) &&
    market.quoteToken.decimals === QUOTE_DECIMALS &&
    market.quoteDecimals === QUOTE_DECIMALS &&
    exchangeMints[chain.params.quoteToken] === market.quoteToken.mint;
  const baseMatches =
    sameSymbol(chain.baseSymbol, pinned.baseSymbol) &&
    market.baseDecimals === pinned.baseDecimals &&
    (market.kind === "perp"
      ? market.baseToken === null
      : market.baseToken !== null &&
        sameSymbol(market.baseToken.symbol, pinned.baseSymbol) &&
        market.baseToken.decimals === pinned.baseDecimals &&
        exchangeMints[chain.params.baseToken] === market.baseToken.mint);
  return (
    chain.header.marketId === market.marketId &&
    chain.params.marketId === market.marketId &&
    chain.params.kind === kind &&
    chain.params.baseLot.toString() === market.lotSize &&
    chain.params.tick.toString() === market.tick &&
    quoteMatches &&
    baseMatches
  );
}
