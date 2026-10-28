import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AccountDock } from "@/components/AccountDock";
import { OrderEntry } from "@/components/OrderEntry";
import {
  MARKET_ORDERS_PAUSED_REASON,
  TRADING_PAUSED_NOTICE,
  type TradingPause,
} from "@/lib/trading/tradingHealth";
import type { MarketInfo } from "@/lib/market-data/types";
import type { Balance, OpenOrder } from "@/lib/trading/types";

const NOW = 1_800_000_000_000;

const SOL: MarketInfo = {
  id: "NSOL-PERP",
  kind: "perp",
  base: "SOL",
  quote: "USDC",
  tickSize: "0.010000",
  lotSize: "0.001000",
  maxLeverage: 5,
  markPrice: "150.000000",
  markPriceUpdatedAtMs: NOW,
  change24hPercent: 0,
  volume24h: "0",
  openInterest: "0",
};

function order(expiresAtMs: number | null | undefined): OpenOrder {
  return {
    orderId: "7",
    tag: "",
    market: "NSOL-PERP",
    side: "buy",
    type: "limit",
    price: "149.00",
    size: "1.000",
    remainingSize: "1.000",
    reduceOnly: false,
    expiresAtMs,
  };
}

function dock(openOrder: OpenOrder, props: { expiryNow?: number } = {}): string {
  return renderToStaticMarkup(
    <AccountDock
      tab="openOrders"
      onTabChange={() => {}}
      positions={[]}
      openOrders={[openOrder]}
      ownFills={[]}
      balances={[]}
      collateral={null}
      marketSettings={(id) => (id === SOL.id ? SOL : undefined)}
      marksByMarket={{}}
      now={NOW}
      hasWallet
      quoteSymbol="USDC"
      onTransfer={null}
      onClosePosition={() => {}}
      onReducePosition={() => {}}
      onCancelOrder={() => {}}
      cancellingOrderIds={new Set()}
      {...props}
    />,
  );
}

describe("the Open orders table and an expired order", () => {
  it("counts the time left against the rollup's clock when it is given", () => {
    const html = dock(order(NOW + 5 * 60_000));
    expect(html).toContain("5m");
    const ahead = dock(order(NOW + 5 * 60_000), { expiryNow: NOW + 6 * 60_000 });
    expect(ahead).toContain("Expired");
    expect(ahead).toContain("It still holds its margin until it is cancelled.");
  });

  it("shows Expired once the clock is past the expiry, and marks the cell", () => {
    const html = dock(order(NOW - 1_000));
    expect(html).toContain("Expired");
    expect(html).toContain("text-warning");
  });

  it("does not call an order without an expiry expired", () => {
    const html = dock(order(null), { expiryNow: NOW + 10 * 365 * 86_400_000 });
    expect(html).toContain("Never");
    expect(html).not.toContain("Expired");
  });
});

const COLLATERAL: Balance = {
  asset: "USDC",
  available: "100.000000",
  reserved: "0.000000",
  total: "100.000000",
};

function ticket(tradingPause: TradingPause | null): string {
  return renderToStaticMarkup(
    <OrderEntry
      market={SOL}
      mark={{ price: "150.000000", time: NOW }}
      now={NOW}
      hasWallet
      walletReady
      walletLocked={false}
      balances={{}}
      collateral={COLLATERAL}
      accountError={null}
      accountLoaded
      onOrderUnknown={() => {}}
      unknownHold={null}
      onClearUnknownHold={() => {}}
      position={null}
      onCreateWallet={() => {}}
      onFund={async () => ({ kind: "noFaucet" })}
      grantAlreadyUsed
      noFaucet
      quoteSymbol="USDC"
      placeOrder={async () => {
        throw new Error("unused");
      }}
      onOrderPlaced={() => {}}
      onTransferToSpot={null}
      supportsGoodFor
      placeOrderPending={false}
      ownerAddress="owner"
      gate={null}
      makersListed={false}
      tradingPause={tradingPause}
    />,
  );
}

describe("the order ticket while the market maker has no quotes up", () => {
  it("shows no banner when trading is not known to be paused", () => {
    const html = ticket(null);
    expect(html).not.toContain(TRADING_PAUSED_NOTICE);
    expect(html).not.toContain(MARKET_ORDERS_PAUSED_REASON);
    expect(html).not.toMatch(/<option value="market" disabled/);
  });

  it("shows the banner, turns the Market choice off and says why a market order is off", () => {
    const html = ticket({ reason: null });
    expect(html).toContain(TRADING_PAUSED_NOTICE);
    expect(html).toMatch(/<option value="market" disabled/);
    expect(html).not.toMatch(/<option value="limit" disabled/);
    expect(html).toContain(MARKET_ORDERS_PAUSED_REASON);
  });

  it("adds the service's reason when it was plain text", () => {
    const html = ticket({ reason: "NSOL-PERP maker has had no quotes resting for 761 s" });
    expect(html).toContain("NSOL-PERP maker has had no quotes resting for 761 s");
  });
});
