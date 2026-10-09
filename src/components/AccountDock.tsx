"use client";

import {
  formatClockTime,
  formatDecimal,
  formatMoney,
  formatRelativeAge,
  UNAVAILABLE,
} from "@/lib/format";
import { ageMs, isStale, STALE_MARK_MS } from "@/lib/market-data/selectors";
import { priceDecimalsOf, sizeDecimalsOf } from "@/lib/market-data/precision";
import { displayOrderCost, estimateOrderCost } from "@/lib/trading/risk";
import type { OwnFillRecord } from "@/lib/trading/tags";
import type { Balance, MarketSettingsLookup, OpenOrder, Position } from "@/lib/trading/types";
import { btnGhost, panel, sectionLabel } from "@/components/ui/styles";
import { TransferControl, type TransferFn } from "@/components/TransferControl";

export type Tab = "positions" | "openOrders" | "fills" | "balances" | "margin";

const TABS: { id: Tab; label: string }[] = [
  { id: "positions", label: "Positions" },
  { id: "openOrders", label: "Open orders" },
  { id: "fills", label: "Fills" },
  { id: "balances", label: "Balances" },
  { id: "margin", label: "Margin" },
];

export function AccountDock({
  tab,
  onTabChange,
  positions,
  openOrders,
  openOrderFirstSeenAtMs,
  ownFills,
  balances,
  collateral,
  marketSettings,
  marksByMarket,
  now,
  hasWallet,
  onTransfer,
  onClosePosition,
  onReducePosition,
  onCancelOrder,
  cancellingOrderId,
}: {
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  positions: Position[];
  openOrders: OpenOrder[];
  /** This device's own first-seen time per order id (there is no venue-reported placement time on `OpenOrder`): an honest, session-local age, not a fabricated venue timestamp. */
  openOrderFirstSeenAtMs: Record<string, number>;
  ownFills: OwnFillRecord[];
  balances: Balance[];
  /** The separate perpetuals collateral account. `null` in dev mode: one balance, not two. */
  collateral: Balance | null;
  marketSettings: MarketSettingsLookup;
  marksByMarket: Record<string, { price: string; time: number } | null>;
  now: number;
  hasWallet: boolean;
  onTransfer: TransferFn | null;
  /** A reduce-only market order for the position's full size, one click after the usual confirmation. */
  onClosePosition: (position: Position) => void;
  /** Prefills the order form with this position's closing direction and size, without submitting. */
  onReducePosition: (position: Position) => void;
  onCancelOrder: ((market: string, orderId: string) => void) | null;
  cancellingOrderId: string | null;
}) {
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
            onClick={() => onTabChange(item.id)}
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
          <PositionsTable
            positions={positions}
            marketSettings={marketSettings}
            marksByMarket={marksByMarket}
            now={now}
            onClose={onClosePosition}
            onReduce={onReducePosition}
          />
        )}
        {hasWallet && tab === "openOrders" && (
          <OpenOrdersTable
            openOrders={openOrders}
            marketSettings={marketSettings}
            firstSeenAtMs={openOrderFirstSeenAtMs}
            now={now}
            onCancel={onCancelOrder}
            cancellingOrderId={cancellingOrderId}
          />
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
  marksByMarket,
  now,
  onClose,
  onReduce,
}: {
  positions: Position[];
  marketSettings: MarketSettingsLookup;
  marksByMarket: Record<string, { price: string; time: number } | null>;
  now: number;
  onClose: (position: Position) => void;
  onReduce: (position: Position) => void;
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
          <th className="font-normal">Mark</th>
          <th className="font-normal">Unrealised P&amp;L</th>
          <th className="font-normal">Margin used (est.)</th>
          <th className="font-normal">Liquidation (est.)</th>
          <th className="font-normal"></th>
        </tr>
      </thead>
      <tbody>
        {open.map((position) => {
          const settings = marketSettings(position.market);
          const size = Number(position.size);
          const long = size > 0;
          const priceDecimals = settings ? priceDecimalsOf(settings) : 2;
          const sizeDecimals = settings ? sizeDecimalsOf(settings) : 4;
          const mark = marksByMarket[position.market] ?? null;
          const markUsable = mark && !isStale(mark.time, now, STALE_MARK_MS);
          const unrealised = markUsable
            ? (Number(mark.price) - Number(position.entryPrice)) * size
            : null;

          let marginUsed: string | null = null;
          let liquidation: string | null = null;
          if (settings && settings.kind === "perp") {
            const estimate = estimateOrderCost({
              side: long ? "buy" : "sell",
              quantity: String(Math.abs(size)),
              price: position.entryPrice,
              leverage: settings.maxLeverage,
              maxLeverage: settings.maxLeverage,
            });
            const display = displayOrderCost(estimate, priceDecimals);
            marginUsed = display.initialMargin;
            liquidation = display.liquidationPrice;
          }

          return (
            <tr key={position.market} className="border-line-subtle border-t">
              <td className="py-1.5">{position.market}</td>
              <td className={long ? "text-safe" : "text-danger"}>{long ? "long" : "short"}</td>
              <td>{formatDecimal(Math.abs(size), sizeDecimals)}</td>
              <td>{formatDecimal(position.entryPrice, priceDecimals)}</td>
              <td>{markUsable ? formatDecimal(mark!.price, priceDecimals) : UNAVAILABLE}</td>
              <td
                className={
                  unrealised === null ? "text-faint" : unrealised >= 0 ? "text-safe" : "text-danger"
                }
              >
                {unrealised !== null ? formatMoney(unrealised) : "Unavailable - no live mark"}
              </td>
              <td>{marginUsed !== null ? formatMoney(marginUsed) : UNAVAILABLE}</td>
              <td
                title="Estimate: half the market's implied initial margin, computed on this device. Not a venue-confirmed threshold."
                className="underline decoration-dotted"
              >
                {liquidation !== null ? formatDecimal(liquidation, priceDecimals) : UNAVAILABLE}
              </td>
              <td className="py-1.5 text-right">
                <div className="flex justify-end gap-1">
                  <button
                    type="button"
                    className={`${btnGhost} h-7 px-2 text-[11px]`}
                    onClick={() => onReduce(position)}
                  >
                    Reduce
                  </button>
                  <button
                    type="button"
                    className={`${btnGhost} h-7 px-2 text-[11px]`}
                    onClick={() => onClose(position)}
                  >
                    Close
                  </button>
                </div>
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
  firstSeenAtMs,
  now,
  onCancel,
  cancellingOrderId,
}: {
  openOrders: OpenOrder[];
  marketSettings: MarketSettingsLookup;
  firstSeenAtMs: Record<string, number>;
  now: number;
  onCancel: ((market: string, orderId: string) => void) | null;
  cancellingOrderId: string | null;
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
          <th className="font-normal">Age</th>
          <th className="font-normal"></th>
        </tr>
      </thead>
      <tbody>
        {openOrders.map((order) => {
          const settings = marketSettings(order.market);
          const seenAt = firstSeenAtMs[order.orderId];
          const age = seenAt !== undefined ? ageMs(seenAt, now) : null;
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
              <td
                className="text-faint"
                title="Since this device first observed the order, not the venue's own placement time"
              >
                {age !== null ? formatRelativeAge(age) : UNAVAILABLE}
              </td>
              <td className="py-1.5 text-right">
                {onCancel && (
                  <button
                    type="button"
                    className={`${btnGhost} h-7 px-2 text-[11px]`}
                    disabled={cancellingOrderId === order.orderId}
                    onClick={() => onCancel(order.market, order.orderId)}
                  >
                    {cancellingOrderId === order.orderId
                      ? "Cancelling…"
                      : `Cancel #${order.orderId}`}
                  </button>
                )}
              </td>
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
