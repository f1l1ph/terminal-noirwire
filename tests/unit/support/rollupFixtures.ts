import { Keypair } from "@solana/web3.js";
import { transactionFailure } from "@noirwire/orderbook";
import type { KeyValueStore } from "@/lib/wallet/index";

/** A `Response` carrying `body` as JSON, the shape the open and prepare endpoints answer with. */
export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

/** A Map-backed `KeyValueStore`; pass a map to share what the "browser" keeps across page loads. */
export const memoryStore = (map = new Map<string, string>()): KeyValueStore => ({
  getItem: (key) => map.get(key) ?? null,
  setItem: (key, value) => void map.set(key, value),
  removeItem: (key) => void map.delete(key),
});

/**
 * The failure a landed transaction raises when the program refuses with `code` (a
 * `PROGRAM_ERROR` value): custom program errors are reported as `6000 + code`. Goes through the
 * SDK's own factory, so a not-seated code comes back as the subclass the client branches on.
 */
export const programRefusal = (code: number) =>
  transactionFailure("sig", { InstructionError: [0, { Custom: 6000 + code }] });

/** One perp market entry of a public deployment, with fresh addresses. */
export function deploymentMarket(
  marketId: number,
  symbol: string,
  baseDecimals: number,
  lot: string,
) {
  return {
    marketId,
    symbol,
    kind: "perp" as const,
    market: Keypair.generate().publicKey.toBase58(),
    tape: Keypair.generate().publicKey.toBase58(),
    priceFeed: Keypair.generate().publicKey.toBase58(),
    baseToken: null,
    quoteToken: { symbol: "nUSD", mint: Keypair.generate().publicKey.toBase58(), decimals: 6 },
    baseDecimals,
    quoteDecimals: 6,
    lotSize: lot,
    tick: "100",
  };
}
