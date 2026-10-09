import type { Connection, PublicKey } from "@solana/web3.js";
import { decodeMarketAccount, programAddresses } from "./sdk";

const MAX_MARKET_SCAN = 8; // DESIGN.md section 8: at most 8 markets.

/**
 * `/v1/markets` names a market by its string id ("NSOL-PERP") and never its
 * on-chain numeric market id, because sim-noirwire's dev-mode engine has no
 * such thing and this is otherwise the one shared, mode-agnostic shape (see
 * src/lib/sim-api/schema.ts). The on-chain `Market` account is public and
 * carries base/quote symbols and kind, so the numeric id is resolved by
 * scanning (DESIGN.md section 2: "Market, one per market - everyone"), not
 * by asking the service for one more field. Cached per program id: markets
 * are not added or removed while the terminal is open.
 */
export interface ResolvedMarket {
  numericId: number;
  kind: "spot" | "perp";
  base: string;
  quote: string;
  baseToken: number;
  quoteToken: number;
}

export interface ResolvedDeployment {
  markets: ResolvedMarket[];
  /** Token index to symbol, incidental from decoding every market account. */
  tokenSymbols: Map<number, string>;
}

const cache = new Map<string, Promise<ResolvedDeployment>>();

export function resolveDeployment(
  connection: Connection,
  programId: PublicKey,
): Promise<ResolvedDeployment> {
  const key = programId.toBase58();
  const existing = cache.get(key);
  if (existing) return existing;
  const promise = scan(connection, programId);
  cache.set(key, promise);
  return promise;
}

async function scan(connection: Connection, programId: PublicKey): Promise<ResolvedDeployment> {
  const addresses = programAddresses(programId);
  const markets: ResolvedMarket[] = [];
  const tokenSymbols = new Map<number, string>();
  for (let id = 0; id < MAX_MARKET_SCAN; id += 1) {
    const account = await connection.getAccountInfo(addresses.market(id));
    if (!account) continue;
    try {
      const market = decodeMarketAccount(account.data);
      if (!market.header.ready) continue;
      const base = market.baseSymbol.replace(/\0+$/, "");
      const quote = market.quoteSymbol.replace(/\0+$/, "");
      const kind = market.params.kind === 2 ? "perp" : "spot";
      markets.push({
        numericId: id,
        kind,
        base,
        quote,
        baseToken: market.params.baseToken,
        quoteToken: market.params.quoteToken,
      });
      // A perp market's own baseToken/quoteToken both name the collateral
      // token (a perp position is cash-settled, not a real spot holding of
      // "the base asset"), so only a spot market's indices name real spot
      // wallet tokens.
      if (kind === "spot") {
        tokenSymbols.set(market.params.baseToken, base);
        tokenSymbols.set(market.params.quoteToken, quote);
      }
    } catch {
      // Not yet finalized or not this account shape; skip it.
    }
  }
  return { markets, tokenSymbols };
}

export function numericIdFor(
  resolved: readonly ResolvedMarket[],
  base: string,
  quote: string,
  kind: "spot" | "perp",
): number | null {
  const match = resolved.find((m) => m.base === base && m.quote === quote && m.kind === kind);
  return match ? match.numericId : null;
}
