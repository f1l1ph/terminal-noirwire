"use client";

import { useState } from "react";
import { AccountDock, type Tab } from "@/components/AccountDock";
import type { PositionTriggerControls } from "@/components/hooks/usePositionTriggers";
import type { MarketInfo } from "@/lib/market-data/types";
import type { LocalTriggers } from "@/lib/trading/triggerStore";
import type { MarketLimits, Position, TriggerStatuses } from "@/lib/trading/types";

const NOW = 1_800_000_000_000;

const market = (id: string, base: string, tick: string, lot: string, mark: string): MarketInfo => ({
  id,
  kind: "perp",
  base,
  quote: "USDC",
  tickSize: tick,
  lotSize: lot,
  maxLeverage: 10,
  markPrice: mark,
  markPriceUpdatedAtMs: NOW,
  change24hPercent: 0,
  volume24h: "0",
  openInterest: "0",
});

const MARKETS: MarketInfo[] = [
  market("NSOL-PERP", "SOL", "0.01", "0.001", "150.00"),
  market("NETH-PERP", "ETH", "0.10", "0.001", "3200.00"),
  market("NBTC-PERP", "BTC", "1.00", "0.0001", "64000.00"),
  market("NXRP-PERP", "XRP", "0.0001", "1", "0.6000"),
] as MarketInfo[];

const POSITIONS: Position[] = [
  { market: "NSOL-PERP", size: "2.500", entryPrice: "148.00" },
  { market: "NETH-PERP", size: "-1.200", entryPrice: "3180.00" },
  { market: "NBTC-PERP", size: "0.0500", entryPrice: "63000.00" },
  { market: "NXRP-PERP", size: "1000", entryPrice: "0.5800" },
];

const LIMITS = new Map<string, MarketLimits>(
  MARKETS.map((item) => [
    item.id,
    {
      imBps: 1000,
      mmBps: 500,
      takerFeeBps: 5,
      bandBps: 400,
      minSize: item.lotSize,
      minNotional: "1",
      positionCap: "1000000",
      maxOpenOrders: 32,
    },
  ]),
);

const localTrigger = (price: string, long: boolean) => ({
  price,
  size: null,
  slippageBps: 100,
  long,
  setAtMs: NOW - 60_000,
});

const LOCAL: Record<string, LocalTriggers> = {
  "NSOL-PERP": {
    takeProfit: localTrigger("160.00", true),
    stopLoss: localTrigger("140.00", true),
  },
  "NETH-PERP": { stopLoss: localTrigger("3300.0", false) },
  "NBTC-PERP": { takeProfit: localTrigger("68000.00", true) },
};

const STATUSES: Record<string, TriggerStatuses> = {
  "NSOL-PERP": {
    takeProfit: { state: "armed" },
    stopLoss: { state: "unfillable", nextAttemptMs: NOW + 8_000 },
    readAtMs: NOW,
  },
  "NETH-PERP": {
    takeProfit: { state: "armed" },
    stopLoss: { state: "blockedByRestingOrders", nextAttemptMs: NOW + 10_000 },
    readAtMs: NOW,
  },
  "NBTC-PERP": {
    takeProfit: { state: "armed" },
    stopLoss: { state: "gone" },
    readAtMs: NOW - 17 * 60_000,
    stale: true,
  },
  "NXRP-PERP": {
    takeProfit: { state: "gone" },
    stopLoss: { state: "gone" },
    readAtMs: NOW,
  },
};

const CONTROLS: PositionTriggerControls = {
  statusesFor: (id) => STATUSES[id] ?? null,
  localFor: (id) => LOCAL[id] ?? {},
  apply: async () => ({
    done: [],
    failure: "The exchange did not accept this. Nothing was changed. Try again in a moment.",
  }),
  refresh: () => {},
  notice: null,
  dismissNotice: () => {},
  blocked: null,
};

const PARTIAL_CONTROLS: PositionTriggerControls = {
  ...CONTROLS,
  apply: async () => ({
    done: ["Stop loss removed."],
    failure:
      "Take profit was not saved: The take profit would fire straight away at the current price.",
  }),
};

const NOTICE_CONTROLS: PositionTriggerControls = {
  ...CONTROLS,
  notice: { market: "NSOL-PERP", lines: ["Take profit set at 160.00."], failure: null },
};

/** A development-only stand-in for the account dock with take profit and stop loss filled in, so the interface can be looked at without a live exchange. */
export function TriggerFixture({
  withNotice,
  partial = false,
}: {
  withNotice: boolean;
  partial?: boolean;
}) {
  const [tab, setTab] = useState<Tab>("positions");
  return (
    <main className="flex min-h-dvh justify-center p-0 min-[900px]:justify-end min-[900px]:p-4">
      <div className="bg-surface flex h-dvh w-full flex-col min-[900px]:w-[460px]">
        <AccountDock
          tab={tab}
          onTabChange={setTab}
          positions={POSITIONS}
          openOrders={[]}
          ownFills={[]}
          balances={[]}
          collateral={null}
          marketSettings={(id) => MARKETS.find((item) => item.id === id)}
          marksByMarket={Object.fromEntries(
            MARKETS.map((item) => [item.id, { price: item.markPrice ?? "0", time: NOW }]),
          )}
          now={NOW}
          hasWallet
          quoteSymbol="USDC"
          onTransfer={null}
          onClosePosition={() => {}}
          onReducePosition={() => {}}
          onCancelOrder={null}
          cancellingOrderIds={new Set()}
          limits={LIMITS}
          triggers={withNotice ? NOTICE_CONTROLS : partial ? PARTIAL_CONTROLS : CONTROLS}
          bordered={false}
        />
      </div>
    </main>
  );
}
