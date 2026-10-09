"use client";

import { useState } from "react";
import { formatClockTime, formatMoney, formatPrice, formatSize, UNAVAILABLE } from "@/lib/format";
import { displayOrderCost, estimateOrderCost } from "@/lib/trading/risk";
import type { Balance, OpenOrder, OwnFill, Position } from "@/lib/trading/types";
import type { MarketSettingsLookup } from "@/lib/trading/types";
import { panel } from "@/components/ui/styles";

type Tab = "positions" | "openOrders" | "fills" | "balances" | "margin";

const TABS: { id: Tab; label: string }[] = [
  { id: "positions", label: "Positions" },
  { id: "openOrders", label: "Open orders" },
  { id: "fills", label: "Fills" },
  { id: "balances", label: "Balances" },
  { id: "margin", label: "Margin" },
];

export function AccountDock({
  positions,
  openOrders,
  fills,
  balances,
  marketSettings,
  hasWallet,
}: {
  positions: Position[];
  openOrders: OpenOrder[];
  fills: OwnFill[];
  balances: Balance[];
  marketSettings: MarketSettingsLookup;
  hasWallet: boolean;
}) {
  const [tab, setTab] = useState<Tab>("positions");

  return (
    <div className={`${panel} flex flex-col`}>
      <div
        className="border-line-subtle flex gap-1 border-b p-2"
        role="tablist"
        aria-label="Account"
      >
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={`rounded-tile min-h-11 px-3 text-[13px] ${
              tab === item.id ? "bg-elevated text-ink-strong" : "text-dim hover:bg-surface-raised"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="max-h-[220px] overflow-y-auto p-3" role="tabpanel">
        {!hasWallet && (
          <p className="text-dim text-[13px]">Create a test wallet to see your account.</p>
        )}
        {hasWallet && tab === "positions" && (
          <PositionsTable positions={positions} marketSettings={marketSettings} />
        )}
        {hasWallet && tab === "openOrders" && (
          <OpenOrdersTable openOrders={openOrders} marketSettings={marketSettings} />
        )}
        {hasWallet && tab === "fills" && (
          <FillsTable fills={fills} marketSettings={marketSettings} />
        )}
        {hasWallet && tab === "balances" && <BalancesTable balances={balances} />}
        {hasWallet && tab === "margin" && (
          <MarginTable positions={positions} marketSettings={marketSettings} />
        )}
      </div>
    </div>
  );
}

function PositionsTable({
  positions,
  marketSettings,
}: {
  positions: Position[];
  marketSettings: MarketSettingsLookup;
}) {
  if (positions.length === 0) return <p className="text-faint text-[13px]">No open positions.</p>;
  return (
    <table className="tnum w-full text-left text-[13px]">
      <thead className="text-faint text-[11px] uppercase">
        <tr>
          <th className="font-normal">Market</th>
          <th className="font-normal">Side</th>
          <th className="font-normal">Quantity</th>
          <th className="font-normal">Entry</th>
          <th className="font-normal">Leverage</th>
          <th className="font-normal">Est. liquidation</th>
        </tr>
      </thead>
      <tbody>
        {positions.map((position) => {
          const settings = marketSettings(position.market);
          return (
            <tr key={position.market} className="border-line-subtle border-t">
              <td className="py-1.5">{position.market}</td>
              <td className={position.side === "buy" ? "text-safe" : "text-danger"}>
                {position.side === "buy" ? "long" : "short"}
              </td>
              <td>{formatSize(position.quantity, settings?.sizeDecimals ?? 4)}</td>
              <td>{formatPrice(position.entryPrice, settings?.priceDecimals ?? 2)}</td>
              <td>{position.leverage}x</td>
              <td>
                {position.liquidationPrice
                  ? formatPrice(position.liquidationPrice, settings?.priceDecimals ?? 2)
                  : UNAVAILABLE}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function OpenOrdersTable({
  openOrders,
  marketSettings,
}: {
  openOrders: OpenOrder[];
  marketSettings: MarketSettingsLookup;
}) {
  if (openOrders.length === 0) return <p className="text-faint text-[13px]">No open orders.</p>;
  return (
    <table className="tnum w-full text-left text-[13px]">
      <thead className="text-faint text-[11px] uppercase">
        <tr>
          <th className="font-normal">Market</th>
          <th className="font-normal">Side</th>
          <th className="font-normal">Quantity</th>
          <th className="font-normal">Filled</th>
          <th className="font-normal">Price</th>
          <th className="font-normal">Placed</th>
        </tr>
      </thead>
      <tbody>
        {openOrders.map((order) => {
          const settings = marketSettings(order.market);
          return (
            <tr key={order.orderId} className="border-line-subtle border-t">
              <td className="py-1.5">{order.market}</td>
              <td className={order.side === "buy" ? "text-safe" : "text-danger"}>
                {order.side === "buy" ? "buy" : "sell"}
              </td>
              <td>{formatSize(order.quantity, settings?.sizeDecimals ?? 4)}</td>
              <td>{formatSize(order.filledQuantity, settings?.sizeDecimals ?? 4)}</td>
              <td>
                {order.limitPrice
                  ? formatPrice(order.limitPrice, settings?.priceDecimals ?? 2)
                  : "market"}
              </td>
              <td>{formatClockTime(new Date(order.placedAt))}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function FillsTable({
  fills,
  marketSettings,
}: {
  fills: OwnFill[];
  marketSettings: MarketSettingsLookup;
}) {
  if (fills.length === 0) return <p className="text-faint text-[13px]">No fills yet.</p>;
  return (
    <table className="tnum w-full text-left text-[13px]">
      <thead className="text-faint text-[11px] uppercase">
        <tr>
          <th className="font-normal">Market</th>
          <th className="font-normal">Side</th>
          <th className="font-normal">Price</th>
          <th className="font-normal">Quantity</th>
          <th className="font-normal">Fee</th>
          <th className="font-normal">Time</th>
        </tr>
      </thead>
      <tbody>
        {fills.map((fill) => {
          const settings = marketSettings(fill.market);
          return (
            <tr key={fill.fillId} className="border-line-subtle border-t">
              <td className="py-1.5">{fill.market}</td>
              <td className={fill.side === "buy" ? "text-safe" : "text-danger"}>
                {fill.side === "buy" ? "buy" : "sell"}
              </td>
              <td>{formatPrice(fill.price, settings?.priceDecimals ?? 2)}</td>
              <td>{formatSize(fill.quantity, settings?.sizeDecimals ?? 4)}</td>
              <td>{formatMoney(fill.fee)}</td>
              <td>{formatClockTime(new Date(fill.time))}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function BalancesTable({ balances }: { balances: Balance[] }) {
  if (balances.length === 0) return <p className="text-faint text-[13px]">No balances yet.</p>;
  return (
    <table className="tnum w-full text-left text-[13px]">
      <thead className="text-faint text-[11px] uppercase">
        <tr>
          <th className="font-normal">Asset</th>
          <th className="font-normal">Available</th>
          <th className="font-normal">Total</th>
        </tr>
      </thead>
      <tbody>
        {balances.map((balance) => (
          <tr key={balance.asset} className="border-line-subtle border-t">
            <td className="py-1.5">{balance.asset}</td>
            <td>{formatMoney(balance.available)}</td>
            <td>{formatMoney(balance.total)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MarginTable({
  positions,
  marketSettings,
}: {
  positions: Position[];
  marketSettings: MarketSettingsLookup;
}) {
  const perpPositions = positions.filter(
    (position) => marketSettings(position.market)?.kind === "perp",
  );
  if (perpPositions.length === 0)
    return <p className="text-faint text-[13px]">No perp positions.</p>;
  return (
    <table className="tnum w-full text-left text-[13px]">
      <thead className="text-faint text-[11px] uppercase">
        <tr>
          <th className="font-normal">Market</th>
          <th className="font-normal">Initial margin (est.)</th>
          <th className="font-normal">Maintenance margin (est.)</th>
        </tr>
      </thead>
      <tbody>
        {perpPositions.map((position) => {
          const settings = marketSettings(position.market);
          if (!settings) return null;
          const estimate = estimateOrderCost({
            side: position.side,
            quantity: position.quantity,
            price: position.entryPrice,
            leverage: position.leverage,
            takerFeeBps: settings.takerFeeBps,
          });
          const display = displayOrderCost(estimate, settings.priceDecimals);
          return (
            <tr key={position.market} className="border-line-subtle border-t">
              <td className="py-1.5">{position.market}</td>
              <td>{formatMoney(display.initialMargin)}</td>
              <td>{formatMoney(display.maintenanceMargin)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
