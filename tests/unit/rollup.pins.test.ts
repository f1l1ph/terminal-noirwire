import { describe, expect, it } from "vitest";
import { fetchDeployment, type PublicDeployment } from "@/lib/rollup/deployment";
import { MAINNET_PINS } from "@/lib/rollup/pins";
import { trustedProgramId } from "@/lib/rollup/session";

function deployment(over: Partial<PublicDeployment> = {}, mint = MAINNET_PINS.usdcMint) {
  return {
    network: "mainnet",
    programId: MAINNET_PINS.programId,
    solanaRpcUrl: "https://api.mainnet-beta.solana.com",
    rollupRpcUrl: "https://attacker.example",
    rollupWsUrl: "wss://attacker.example",
    exchange: "Exchange1111111111111111111111111111111111",
    stats: "Stats11111111111111111111111111111111111111",
    markets: [
      {
        marketId: 0,
        symbol: "SOL-PERP",
        kind: "perp",
        market: "Market111111111111111111111111111111111111",
        tape: "Tape1111111111111111111111111111111111111",
        priceFeed: "Feed11111111111111111111111111111111111111",
        baseToken: null,
        quoteToken: { symbol: "USDC", mint, decimals: 6 },
        baseDecimals: 9,
        quoteDecimals: 6,
        lotSize: "1000000",
        tick: "1",
      },
    ],
    ...over,
  };
}

let counter = 0;
function fetchOf(body: unknown, pins?: typeof MAINNET_PINS) {
  const fetchFn = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
  counter += 1;
  return fetchDeployment(`https://sim-${counter}.example`, { pins }, fetchFn);
}

describe("a mainnet build checking /v1/deployment", () => {
  it("accepts the pinned values and uses the pinned rollup URLs, not the answer's", async () => {
    const accepted = await fetchOf(deployment(), MAINNET_PINS);
    expect(accepted.rollupRpcUrl).toBe(MAINNET_PINS.rollupRpcUrl);
    expect(accepted.rollupWsUrl).toBe(MAINNET_PINS.rollupWsUrl);
  });

  it("refuses another network", async () => {
    await expect(fetchOf(deployment({ network: "devnet" }), MAINNET_PINS)).rejects.toThrow(
      /devnet network/,
    );
  });

  it("refuses another program id", async () => {
    await expect(
      fetchOf(deployment({ programId: "11111111111111111111111111111111" }), MAINNET_PINS),
    ).rejects.toThrow(/describes program/);
  });

  it("refuses a market priced in another mint", async () => {
    await expect(
      fetchOf(deployment({}, "So11111111111111111111111111111111111111112"), MAINNET_PINS),
    ).rejects.toThrow(/prices a market in token/);
  });

  it("refuses a market other than the launched one", async () => {
    const body = deployment();
    const second = { ...body.markets[0], marketId: 1 };
    await expect(
      fetchOf({ ...body, markets: [body.markets[0], second] }, MAINNET_PINS),
    ).rejects.toThrow(/not launched/);
  });

  it("refuses the answer a test-build caller already fetched, on the same service", async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify(
          deployment({ network: "devnet", programId: "11111111111111111111111111111111" }),
        ),
        { status: 200 },
      )) as typeof fetch;
    const sim = "https://sim-cache-sequence.example";
    await fetchDeployment(sim, {}, fetchFn);
    await expect(fetchDeployment(sim, { pins: MAINNET_PINS }, fetchFn)).rejects.toThrow(
      /devnet network/,
    );
  });

  it("picks up a corrected service answer after refusing a wrong one, without a reload", async () => {
    let answer = deployment({ network: "devnet" });
    const fetchFn = (async () =>
      new Response(JSON.stringify(answer), { status: 200 })) as typeof fetch;
    const sim = "https://sim-evict.example";
    await expect(fetchDeployment(sim, { pins: MAINNET_PINS }, fetchFn)).rejects.toThrow(
      /devnet network/,
    );
    answer = deployment();
    const corrected = await fetchDeployment(sim, { pins: MAINNET_PINS }, fetchFn);
    expect(corrected.network).toBe("mainnet");
  });

  it("trusts the pinned program id over an override", () => {
    expect(
      trustedProgramId({
        pins: MAINNET_PINS,
        programId: "11111111111111111111111111111111",
      }).toBase58(),
    ).toBe(MAINNET_PINS.programId);
  });
});

describe("the pinned Solana cluster", () => {
  it("is the mainnet genesis hash", () => {
    expect(MAINNET_PINS.solanaGenesis).toBe("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d");
  });
});

describe("a test build checking /v1/deployment", () => {
  it("accepts whatever test network, program and mint the service names", async () => {
    const accepted = await fetchOf(
      deployment({ network: "devnet", programId: "11111111111111111111111111111111" }, "Other"),
    );
    expect(accepted.rollupRpcUrl).toBe("https://attacker.example");
  });

  it("refuses an answer naming the mainnet network", async () => {
    await expect(
      fetchOf(deployment({ programId: "11111111111111111111111111111111" })),
    ).rejects.toThrow(/mainnet network/);
  });

  it("refuses an answer naming the mainnet program under another network name", async () => {
    await expect(fetchOf(deployment({ network: "devnet" }))).rejects.toThrow(/mainnet network/);
  });
});
