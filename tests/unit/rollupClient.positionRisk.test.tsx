import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Keypair } from "@solana/web3.js";
import { AccountDock, UNREADABLE_EXPOSURE_NOTE, type Tab } from "@/components/AccountDock";
import { keypairOwnerSigner } from "@/lib/wallet/ownerSigner";
import { RollupTradingClient } from "@/lib/trading/rollupClient";
import type { RollupSession, TraderClientLike } from "@/lib/rollup/session";
import type { PublicDeployment } from "@/lib/rollup/deployment";
import type { MarketInfo } from "@/lib/market-data/types";
import type { TraderState, WalletIdentity } from "@/lib/trading/types";
import type { View } from "@/lib/rollup/sdk";

const NOW = 1_800_000_000_000;
const USDC = 1_000_000n;
const OWNER = Keypair.generate();
const WALLET: WalletIdentity = {
  address: OWNER.publicKey.toBase58(),
  secretKeyHex: "aa".repeat(64),
};

const SOL: MarketInfo = {
  id: "NSOL-PERP",
  kind: "perp",
  base: "SOL",
  quote: "nUSD",
  tickSize: "0.010000",
  lotSize: "0.001000",
  maxLeverage: 10,
  markPrice: "150.000000",
  markPriceUpdatedAtMs: NOW,
  change24hPercent: 0,
  volume24h: "0",
  openInterest: "0",
};

const DEPLOYMENT: PublicDeployment = {
  network: "localnet",
  programId: Keypair.generate().publicKey.toBase58(),
  solanaRpcUrl: "http://127.0.0.1:8899",
  rollupRpcUrl: "http://127.0.0.1:6699",
  rollupWsUrl: "ws://127.0.0.1:6700",
  exchange: Keypair.generate().publicKey.toBase58(),
  stats: Keypair.generate().publicKey.toBase58(),
  markets: [
    {
      marketId: 0,
      symbol: "NSOL-PERP",
      kind: "perp",
      market: Keypair.generate().publicKey.toBase58(),
      tape: Keypair.generate().publicKey.toBase58(),
      priceFeed: Keypair.generate().publicKey.toBase58(),
      baseToken: null,
      quoteToken: { symbol: "nUSD", mint: Keypair.generate().publicKey.toBase58(), decimals: 6 },
      baseDecimals: 9,
      quoteDecimals: 6,
      lotSize: "1000000",
      tick: "100",
    },
  ],
};

const emptySlot = { base: 0n, quote: 0n, openBidLots: 0n, openAskLots: 0n };

function stateFor(maintenance: ReadonlyMap<number, number> | undefined): Promise<TraderState> {
  const view = {
    orderKeys: [],
    resultsWritten: 1,
    results: [],
    snapshot: {
      seat: {
        collateral: 500n * USDC,
        spot: [],
        perp: [{ ...emptySlot, base: 10_000n, quote: -1000n * USDC }, { ...emptySlot }],
        openOrders: [],
      },
      marketId: 0,
      orders: [],
    },
  } as unknown as View;
  const unused = async () => {
    throw new Error("unused");
  };
  const client: TraderClientLike = {
    view: async () => view,
    subscribeView: () => async () => {},
    placeOrder: unused,
    cancelOrder: unused,
    cancelAll: unused,
    syncView: unused,
    transferBetweenBalances: unused,
  };
  const session = (): RollupSession => ({
    owner: keypairOwnerSigner(OWNER),
    orderKeyPublicKeys: [],
    client,
    deployment: DEPLOYMENT,
    tokenIndexBySymbol: new Map([["nUSD", 0]]),
    collateralToken: { mint: Keypair.generate().publicKey, custodyNonce: 0n },
    gate: Keypair.generate().publicKey,
    maintenanceMarginBps: maintenance,
    tokenExpiresAtMs: Number.MAX_SAFE_INTEGER,
    saveKeyCheckpoint: () => {},
    close: () => {},
  });
  return new RollupTradingClient({
    simUrl: "http://sim.test",
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    now: () => NOW,
    marketSettingsLookup: (id) => (id === SOL.id ? SOL : undefined),
    buildSession: async () => session(),
  }).fetchState(WALLET);
}

function dockFor(
  state: TraderState,
  {
    tab = "positions",
    exposureUnreadable = false,
  }: { tab?: Tab; exposureUnreadable?: boolean } = {},
): string {
  return renderToStaticMarkup(
    <AccountDock
      tab={tab}
      exposureUnreadable={exposureUnreadable}
      onTabChange={() => {}}
      positions={Object.values(state.positions)}
      openOrders={[]}
      ownFills={[]}
      balances={[]}
      collateral={state.collateral ?? null}
      marketSettings={(id) => (id === SOL.id ? SOL : undefined)}
      marksByMarket={{ [SOL.id]: { price: "150.000000", time: NOW } }}
      now={NOW}
      hasWallet
      quoteSymbol="nUSD"
      onTransfer={null}
      onClosePosition={() => {}}
      onReducePosition={() => {}}
      onCancelOrder={null}
      cancellingOrderIds={new Set()}
    />,
  );
}

describe("a mapped rollup position carries what the program computes margin from", () => {
  it("carries the slot's quote and the market's maintenance margin", async () => {
    const state = await stateFor(new Map([[0, 500]]));
    expect(state.positions["NSOL-PERP"]).toMatchObject({
      size: "10.000",
      quote: "-1000.000000",
      maintenanceMarginBps: 500,
    });
  });

  it("switches the dock to break-even, position P&L and a liquidation from the real collateral", async () => {
    const html = dockFor(await stateFor(new Map([[0, 500]])));
    expect(html).toContain("Break-even");
    expect(html).toContain("Position P&amp;L");
    expect(html).not.toContain("Unrealised P&amp;L");
    // 10 SOL, cash flow -1000, collateral 500, mm 5%: liquidated at (1000 - 500) / (10 * 0.95).
    expect(html).toContain("52.63");
    // 10 * 150 - 1000
    expect(html).toContain("+500.00 nUSD");
  });

  it("shows the position's leverage against the market maximum, and none in dev mode", async () => {
    const html = dockFor(await stateFor(new Map([[0, 500]])));
    // 10 * 150 = 1500 of value over 500 collateral + 500 profit = 1000 equity.
    expect(html).toContain("Leverage");
    expect(html).toContain("1.5x of 10x max");
    const dev = dockFor(await stateFor(undefined));
    expect(dev).not.toContain("Leverage");
  });

  it("shows liquidation as unavailable, with a note, when the account holds exposure it cannot read", async () => {
    const state = await stateFor(new Map([[0, 500]]));
    for (const tab of ["positions", "margin"] as const) {
      const html = dockFor(state, { tab, exposureUnreadable: true });
      expect(html).toContain(UNREADABLE_EXPOSURE_NOTE);
      expect(html).not.toContain("52.63");
    }
    expect(dockFor(state, { exposureUnreadable: true })).not.toContain("+500.00 nUSD");
    expect(dockFor(state, { tab: "positions" })).not.toContain(UNREADABLE_EXPOSURE_NOTE);
  });

  it("keeps the older labels when the session knows no maintenance margin", async () => {
    const state = await stateFor(undefined);
    expect(state.positions["NSOL-PERP"]?.maintenanceMarginBps).toBeUndefined();
    const html = dockFor(state);
    expect(html).toContain("Unrealised P&amp;L");
    expect(html).not.toContain("Break-even");
  });
});
