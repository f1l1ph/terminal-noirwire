import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { marketMatchesChain, pinnedBaseDecimals } from "@/lib/rollup/markets";
import type { PublicDeployment } from "@/lib/rollup/deployment";
import { MARKET_KIND_CODE } from "@/lib/rollup/sdk";

const QUOTE_MINT = Keypair.generate().publicKey.toBase58();
const MINTS = [QUOTE_MINT];

const PERP: PublicDeployment["markets"][number] = {
  marketId: 0,
  symbol: "NSOL-PERP",
  kind: "perp",
  market: "",
  tape: "",
  priceFeed: "",
  baseToken: null,
  quoteToken: { symbol: "nUSD", mint: QUOTE_MINT, decimals: 6 },
  baseDecimals: 9,
  quoteDecimals: 6,
  lotSize: "1000000",
  tick: "100",
};

const CHAIN = {
  header: { tag: "nwmarket", ready: true, marketId: 0, bump: 0 },
  params: {
    marketId: 0,
    kind: MARKET_KIND_CODE.perp,
    baseLot: 1_000_000n,
    tick: 100n,
    baseToken: 0,
    quoteToken: 0,
  },
  baseSymbol: "NSOL",
  quoteSymbol: "NUSD",
  capacity: 1024,
} as never;

describe("marketMatchesChain", () => {
  it("accepts an entry that says what the market account says", () => {
    expect(marketMatchesChain(PERP, CHAIN, MINTS)).toBe(true);
  });

  it.each([
    ["base decimals", { baseDecimals: 12 }],
    ["lot", { lotSize: "1000" }],
    ["tick", { tick: "1" }],
    ["market id", { marketId: 1 }],
    ["kind", { kind: "spot" as const }],
    ["quote decimals", { quoteDecimals: 9 }],
    ["quote mint", { quoteToken: { symbol: "nUSD", mint: "other", decimals: 6 } }],
    ["unpinned market", { symbol: "NBTC-PERP" }],
  ])("refuses a different %s", (_field, change) => {
    expect(marketMatchesChain({ ...PERP, ...change }, CHAIN, MINTS)).toBe(false);
  });

  it("only pins the markets this build trades", () => {
    expect(pinnedBaseDecimals("NSOL-PERP")).toBe(9);
    expect(pinnedBaseDecimals("NNVDA-PERP")).toBe(6);
    expect(pinnedBaseDecimals("NBTC-PERP")).toBeNull();
  });
});
