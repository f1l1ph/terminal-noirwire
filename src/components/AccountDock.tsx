"use client";

import { useState } from "react";
import { formatClockTime, formatDecimal, formatMoney, UNAVAILABLE } from "@/lib/format";
import { priceDecimalsOf, sizeDecimalsOf } from "@/lib/market-data/precision";
import { displayOrderCost, estimateOrderCost } from "@/lib/trading/risk";
import type { OwnFillRecord } from "@/lib/trading/tags";
import type { Balance, MarketSettingsLookup, OpenOrder, Position } from "@/lib/trading/types";
import { panel, sectionLabel } from "@/components/ui/styles";
import { TransferControl, type TransferFn } from "@/components/TransferControl";

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
  ownFills,
  balances,
  collateral,
  marketSettings,
  hasWallet,
  onTransfer,
}: {
  positions: Position[];
  openOrders: OpenOrder[];
  ownFills: OwnFillRecord[];
  balances: Balance[];
  /** The separate perpetuals collateral account. `null` in dev mode: one balance, not two. */
  collateral: Balance | null;
  marketSettings: MarketSettingsLookup;
  hasWallet: boolean;
  onTransfer: TransferFn | null;
}) {
  const [tab, setTab] = useState<Tab>("positions");

  return (
    <div className={`${panel} flex min-h-0 flex-1 flex-col`}>
      <div
        className="border-line-subtle flex shrink-0 gap-1 border-b p-2"
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
            className={`rounded-tile min-h-9 px-3 text-[13px] ${
              tab === item.id ? "bg-elevated text-ink-strong" : "text-dim hover:bg-surface-raised"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3" role="tabpanel">
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
          <FillsTable fills={ownFills} marketSettings={marketSettings} />
        )}
        {hasWallet && tab === "balances" && (
          <BalancesTable balances={balances} collateral={collateral} onTransfer={onTransfer} />
        )}
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
  const open = positions.filter((position) => Number(position.size) !== 0);
  if (open.length === 0) return <p className="text-faint text-[13px]">No open positions.</p>;
  return (
    <table className="tnum w-full text-left text-[13px]">
      <thead className="text-faint text-[11px] uppercase">
        <tr>
          <th className="font-normal">Market</th>
          <th className="font-normal">Side</th>
          <th className="font-normal">Size</th>
          <th className="font-normal">Entry</th>
        </tr>
      </thead>
      <tbody>
        {open.map((position) => {
          const settings = marketSettings(position.market);
          const size = Number(position.size);
          const long = size > 0;
          return (
            <tr key={position.market} className="border-line-subtle border-t">
              <td className="py-1.5">{position.market}</td>
              <td className={long ? "text-safe" : "text-danger"}>{long ? "long" : "short"}</td>
              <td>{formatDecimal(Math.abs(size), settings ? sizeDecimalsOf(settings) : 4)}</td>
              <td>
                {formatDecimal(position.entryPrice, settings ? priceDecimalsOf(settings) : 2)}
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
          <th className="font-normal">Type</th>
          <th className="font-normal">Price</th>
          <th className="font-normal">Remaining</th>
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
              <td className="text-dim">{order.type}</td>
              <td>
                {order.price
                  ? formatDecimal(order.price, settings ? priceDecimalsOf(settings) : 2)
                  : UNAVAILABLE}
              </td>
              <td>{formatDecimal(order.remainingSize, settings ? sizeDecimalsOf(settings) : 4)}</td>
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
  fills: OwnFillRecord[];
  marketSettings: MarketSettingsLookup;
}) {
  if (fills.length === 0)
    return <p className="text-faint text-[13px]">No fills yet this session.</p>;
  return (
    <table className="tnum w-full text-left text-[13px]">
      <thead className="text-faint text-[11px] uppercase">
        <tr>
          <th className="font-normal">Market</th>
          <th className="font-normal">Side</th>
          <th className="font-normal">Price</th>
          <th className="font-normal">Size</th>
          <th className="font-normal">Time</th>
        </tr>
      </thead>
      <tbody>
        {fills.map((fill) => {
          const settings = marketSettings(fill.market);
          return (
            <tr key={fill.sequence} className="border-line-subtle border-t">
              <td className="py-1.5">{fill.market}</td>
              <td className={fill.side === "buy" ? "text-safe" : "text-danger"}>
                {fill.side === "buy" ? "buy" : "sell"}
              </td>
              <td>{formatDecimal(fill.price, settings ? priceDecimalsOf(settings) : 2)}</td>
              <td>{formatDecimal(fill.size, settings ? sizeDecimalsOf(settings) : 4)}</td>
              <td>{formatClockTime(new Date(fill.timestampMs))}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function BalancesTable({
  balances,
  collateral,
  onTransfer,
}: {
  balances: Balance[];
  collateral: Balance | null;
  onTransfer: TransferFn | null;
}) {
  const rows = collateral
    ? [{ ...collateral, asset: "nUSD (perpetuals collateral)" }, ...balances]
    : balances;
  if (rows.length === 0) return <p className="text-faint text-[13px]">No balances yet.</p>;
  return (
    <>
      <table className="tnum w-full text-left text-[13px]">
        <thead className="text-faint text-[11px] uppercase">
          <tr>
            <th className="font-normal">Asset</th>
            <th className="font-normal">Available</th>
            <th className="font-normal">Reserved</th>
            <th className="font-normal">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((balance) => (
            <tr key={balance.asset} className="border-line-subtle border-t">
              <td className="py-1.5">{balance.asset}</td>
              <td>
                {balance.asset.startsWith("nUSD")
                  ? formatMoney(balance.available)
                  : formatDecimal(balance.available, 6)}
              </td>
              <td>
                {balance.asset.startsWith("nUSD")
                  ? formatMoney(balance.reserved)
                  : formatDecimal(balance.reserved, 6)}
              </td>
              <td>
                {balance.asset.startsWith("nUSD")
                  ? formatMoney(balance.total)
                  : formatDecimal(balance.total, 6)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {onTransfer && collateral && (
        <TransferControl
          onTransfer={onTransfer}
          collateral={collateral}
          spot={balances.find((balance) => balance.asset === "nUSD") ?? null}
        />
      )}
    </>
  );
}

function MarginTable({
  positions,
  marketSettings,
}: {
  positions: Position[];
  marketSettings: MarketSettingsLookup;
}) {
  const perpPositions = positions.filter((position) => {
    const settings = marketSettings(position.market);
    return Number(position.size) !== 0 && settings?.kind === "perp";
  });
  if (perpPositions.length === 0)
    return <p className="text-faint text-[13px]">No perp positions.</p>;
  return (
    <>
      <table className="tnum w-full text-left text-[13px]">
        <thead className="text-faint text-[11px] uppercase">
          <tr>
            <th className="font-normal">Market</th>
            <th className="font-normal">Margin at max leverage (est.)</th>
            <th className="font-normal">Closest est. liquidation</th>
          </tr>
        </thead>
        <tbody>
          {perpPositions.map((position) => {
            const settings = marketSettings(position.market);
            if (!settings) return null;
            const size = Number(position.size);
            // sim-noirwire does not report the margin actually posted for an
            // existing position, only its size and entry price, so the
            // leverage behind it is unknown; this shows the closest
            // (most conservative) estimate, at the market's maximum leverage.
            const estimate = estimateOrderCost({
              side: size > 0 ? "buy" : "sell",
              quantity: String(Math.abs(size)),
              price: position.entryPrice,
              leverage: settings.maxLeverage,
              maxLeverage: settings.maxLeverage,
            });
            const display = displayOrderCost(estimate, priceDecimalsOf(settings));
            return (
              <tr key={position.market} className="border-line-subtle border-t">
                <td className="py-1.5">{position.market}</td>
                <td>{formatMoney(display.initialMargin)}</td>
                <td>
                  {display.liquidationPrice
                    ? formatDecimal(display.liquidationPrice, priceDecimalsOf(settings))
                    : UNAVAILABLE}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className={`${sectionLabel} mt-2`}>Estimate, not a venue guarantee</p>
      <p className="text-faint mt-1 text-[11px] leading-relaxed">
        sim-noirwire does not publish a maintenance margin ratio or fee over the wire; this assumes
        half the implied initial margin (10000 / max leverage) and a 0.05% taker fee, both read from
        its current engine configuration, not from the API. See docs/BUILD-NOTES.md.
      </p>
    </>
  );
}
