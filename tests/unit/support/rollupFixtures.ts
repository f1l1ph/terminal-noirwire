import { Keypair, type PublicKey } from "@solana/web3.js";
import { deriveOrderKey, transactionFailure } from "@noirwire/orderbook";
import type { MarketInfo } from "@/lib/market-data/types";
import type { PublicDeployment } from "@/lib/rollup/deployment";
import type { OrderKeyStatus } from "@/lib/rollup/orderKeySetup";
import type { KeyValueStore } from "@/lib/wallet/index";

export const SEED = new Uint8Array(32).fill(7);
export const STRANGER_SEED = new Uint8Array(32).fill(99);
export const USDC = 1_000_000n;

export const keysOf = (seed: Uint8Array, indices: number[]): PublicKey[] =>
  indices.map((index) => deriveOrderKey(seed, index).publicKey);

export const stages = (statuses: OrderKeyStatus[]) => statuses.map((status) => status.stage);

export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
export const settle = async () => {
  for (let round = 0; round < 5; round += 1) await tick();
};

export const PERP_MARKET: MarketInfo = {
  id: "NSOL-PERP",
  kind: "perp",
  base: "SOL",
  quote: "nUSD",
  tickSize: "0.010000",
  lotSize: "0.001000",
  maxLeverage: 10,
  markPrice: "150.000000",
  markPriceUpdatedAtMs: Date.now(),
  change24hPercent: 0,
  volume24h: "0",
  openInterest: "0",
};

export const singleMarketDeployment = (): PublicDeployment => ({
  network: "localnet",
  programId: Keypair.generate().publicKey.toBase58(),
  solanaRpcUrl: "http://127.0.0.1:8899",
  rollupRpcUrl: "http://127.0.0.1:6699",
  rollupWsUrl: "ws://127.0.0.1:6700",
  exchange: Keypair.generate().publicKey.toBase58(),
  stats: Keypair.generate().publicKey.toBase58(),
  markets: [deploymentMarket(0, "NSOL-PERP", 9, "1000000")],
});

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
