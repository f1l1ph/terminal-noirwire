"use client";

import { fromFixedPoint, withoutSign } from "@/lib/trading/decimal";
import {
  accountLeverage,
  formatLeverage,
  leverageRatio,
  positionRisks,
  unknownPositionRisks,
  type PositionRisk,
} from "@/lib/trading/positionRisk";
import {
  formatClockTime,
  formatDecimal,
  formatMoney,
  formatTimeLeft,
  UNAVAILABLE,
} from "@/lib/format";
import { isStale, STALE_MARK_MS } from "@/lib/market-data/selectors";
import { marketDisplayName } from "@/lib/market-data/displayName";
import { priceDecimalsOf, sizeDecimalsOf } from "@/lib/market-data/precision";
import {
  ASSUMED_TAKER_FEE_BPS,
  displayOrderCost,
  estimateOrderCost,
  MAINTENANCE_MARGIN_BPS,
} from "@/lib/trading/risk";
import type { OwnFillRecord } from "@/lib/trading/tags";
import type {
  Balance,
  MarketLimits,
  MarketSettingsLookup,
  OpenOrder,
  Position,
  Side,
} from "@/lib/trading/types";
import type { MarketInfo } from "@/lib/market-data/types";
import { availableLabel, isAvailableUnknown } from "@/lib/trading/balanceDisplay";
import { btnGhost, sectionLabel } from "@/components/ui/styles";
import { TransferControl, type TransferFn } from "@/components/TransferControl";
import { isMainnetBuild } from "@/lib/network";
import { walletlessDockText } from "@/lib/trading/uiRules";

const NO_LIMITS: ReadonlyMap<string, MarketLimits> = new Map();

/** An existing position's cost at the market's maximum leverage, from the market account's own ratios once they are known. */
function positionCost(
  side: Side,
  quantity: string,
  price: string,
  settings: MarketInfo,
  limits: MarketLimits | undefined,
) {
  return estimateOrderCost({
    side,
    quantity,
    price,
    leverage: limits ? 10_000 / limits.imBps : settings.maxLeverage,
    maxLeverage: settings.maxLeverage,
    takerFeeBps: limits?.takerFeeBps,
    maintenanceBps: limits?.mmBps,
  });
}

const percentOfBps = (bps: number): string => `${bps / 100}%`;

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
  ownFills,
  balances,
  collateral,
  marketSettings,
  marksByMarket,
  now,
  hasWallet,
  quoteSymbol,
  onTransfer,
  onClosePosition,
  onReducePosition,
  onCancelOrder,
  cancellingOrderIds,
  limits = NO_LIMITS,
  exposureUnreadable = false,
  transfers = null,
  bordered = true,
}: {
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  positions: Position[];
  openOrders: OpenOrder[];
  ownFills: OwnFillRecord[];
  balances: Balance[];
  /** The separate perpetuals collateral account. `null` in dev mode: one balance, not two. */
  collateral: Balance | null;
  marketSettings: MarketSettingsLookup;
  marksByMarket: Record<string, { price: string; time: number } | null>;
  now: number;
  hasWallet: boolean;
  /** The quote token's name as the venue gives it (nUSD, USDC); empty while not yet known. */
  quoteSymbol: string;
  /** Null in dev mode and wherever there is no spot market to move funds to. */
  onTransfer: TransferFn | null;
  /** A reduce-only market order for the position's full size, one click after the usual confirmation. */
  onClosePosition: (position: Position) => void;
  /** Prefills the order form with this position's closing direction and size, without submitting. */
  onReducePosition: (position: Position) => void;
  onCancelOrder: ((market: string, orderId: string) => void) | null;
  /** Ids of the orders whose cancel is running; each row's cancel is off by its own id. */
  cancellingOrderIds: ReadonlySet<string>;
  /** Each market's ratios as its account states them, by symbol; the estimates assume defaults for a market not listed. */
  limits?: ReadonlyMap<string, MarketLimits>;
  /** The account holds exposure in a market this terminal cannot read: margin and liquidation figures are unknown. */
  exposureUnreadable?: boolean;
  /** Deposits, withdrawals and the transfers that did not finish, shown above the tabs. */
  transfers?: React.ReactNode;
  /** False inside the desktop Account panel frame, which already supplies the border. True (default) on phone, where this renders standalone. */
  bordered?: boolean;
}) {
  return (
    <div
      className={`flex min-h-0 flex-1 flex-col ${bordered ? "bg-surface border-line-subtle rounded-panel border" : ""}`}
    >
      <div
        className="border-line-subtle flex shrink-0 gap-1 overflow-x-auto border-b p-2"
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
            className={`rounded-tile focus-visible:outline-ink-strong min-h-11 px-3 text-[13px] whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-[-2px] max-sm:flex-1 max-sm:px-1 max-sm:text-[12px] ${
              tab === item.id ? "bg-elevated text-ink-strong" : "text-dim hover:bg-surface-raised"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3" role="tabpanel">
        {hasWallet && transfers && <div className="-mx-3 -mt-3 mb-3">{transfers}</div>}
        {!hasWallet && (
          <div className="flex h-full min-h-[96px] flex-col items-center justify-center gap-1 text-center">
            <p className="text-dim text-[13px]">{walletlessDockText(isMainnetBuild())}</p>
          </div>
        )}
        {hasWallet && tab === "positions" && (
          <PositionsTable
            positions={positions}
            collateral={collateral}
            marketSettings={marketSettings}
            marksByMarket={marksByMarket}
            now={now}
            quoteSymbol={quoteSymbol}
            limits={limits}
            exposureUnreadable={exposureUnreadable}
            onClose={onClosePosition}
            onReduce={onReducePosition}
          />
        )}
        {hasWallet && tab === "openOrders" && (
          <OpenOrdersTable
            openOrders={openOrders}
            marketSettings={marketSettings}
            now={now}
            onCancel={onCancelOrder}
            cancellingOrderIds={cancellingOrderIds}
          />
        )}
        {hasWallet && tab === "fills" && (
          <FillsTable fills={ownFills} marketSettings={marketSettings} />
        )}
        {hasWallet && tab === "balances" && (
          <BalancesTable
            balances={balances}
            collateral={collateral}
            quoteSymbol={quoteSymbol}
            onTransfer={onTransfer}
            now={now}
          />
        )}
        {hasWallet && tab === "margin" && (
          <MarginTable
            positions={positions}
            collateral={collateral}
            marksByMarket={marksByMarket}
            now={now}
            marketSettings={marketSettings}
            quoteSymbol={quoteSymbol}
            limits={limits}
            exposureUnreadable={exposureUnreadable}
          />
        )}
      </div>
    </div>
  );
}

const FUNDING_NOTE = "Funding the venue has not yet settled onto the position is not included.";

function freshMarkLookup(
  marksByMarket: Record<string, { price: string; time: number } | null>,
  now: number,
): (market: string) => string | null {
  return (market) => {
    const mark = marksByMarket[market];
    return mark && !isStale(mark.time, now, STALE_MARK_MS) ? mark.price : null;
  };
}

function liquidationCell(
  risk: PositionRisk | undefined,
  priceDecimals: number,
): { value: string; title: string } {
  const basis = `Estimate from your collateral, all your positions and this market's own maintenance margin, computed on this device. ${FUNDING_NOTE}`;
  const estimate = risk?.liquidation;
  if (!estimate || estimate.kind === "unknown") {
    return {
      value: UNAVAILABLE,
      title: `Not available: a price or margin setting is missing. ${basis}`,
    };
  }
  if (estimate.kind === "none") {
    return { value: "None", title: `No price move against this position liquidates it. ${basis}` };
  }
  if (estimate.kind === "now") {
    return {
      value: "At risk now",
      title: `Your account is below its maintenance margin at the current price. ${basis}`,
    };
  }
  return {
    value: formatDecimal(fromFixedPoint(estimate.price, priceDecimals), priceDecimals),
    title: basis,
  };
}

const LEVERAGE_BASIS = `Position value at the current mark divided by your account equity (collateral plus every position's P&L at its mark). It moves with the price. ${FUNDING_NOTE}`;
const LEVERAGE_UNAVAILABLE = `Not available: it needs a fresh mark for every open position and positive account equity. ${LEVERAGE_BASIS}`;

function leverageCell(
  ratio: number | null,
  maxLeverage: number | null,
): { value: string; title: string } {
  if (ratio === null) return { value: UNAVAILABLE, title: LEVERAGE_UNAVAILABLE };
  const value = formatLeverage(ratio);
  return {
    value: maxLeverage !== null ? `${value} of ${maxLeverage}x max` : value,
    title: LEVERAGE_BASIS,
  };
}

function PositionsTable({
  positions,
  collateral,
  marketSettings,
  marksByMarket,
  now,
  quoteSymbol,
  limits,
  exposureUnreadable,
  onClose,
  onReduce,
}: {
  positions: Position[];
  collateral: Balance | null;
  marketSettings: MarketSettingsLookup;
  marksByMarket: Record<string, { price: string; time: number } | null>;
  now: number;
  quoteSymbol: string;
  limits: ReadonlyMap<string, MarketLimits>;
  exposureUnreadable: boolean;
  onClose: (position: Position) => void;
  onReduce: (position: Position) => void;
}) {
  const open = positions.filter((position) => Number(position.size) !== 0);
  if (open.length === 0) {
    return exposureUnreadable ? (
      <UnreadableExposureNote />
    ) : (
      <EmptyState
        title="No positions yet"
        hint="Your SOL-PERP positions appear here once an order fills."
      />
    );
  }
  const risks = exposureUnreadable
    ? unknownPositionRisks(open)
    : positionRisks(open, collateral?.total ?? null, freshMarkLookup(marksByMarket, now));
  return (
    <>
      {exposureUnreadable && <UnreadableExposureNote />}
      <ul className="flex flex-col gap-2">
        {open.map((position) => {
          const settings = marketSettings(position.market);
          const size = Number(position.size);
          const long = size > 0;
          const priceDecimals = settings ? priceDecimalsOf(settings) : 2;
          const sizeDecimals = settings ? sizeDecimalsOf(settings) : 4;
          const mark = marksByMarket[position.market] ?? null;
          const markUsable = mark && !isStale(mark.time, now, STALE_MARK_MS);
          const risk = risks?.get(position.market);
          const unrealised = risks
            ? risk?.pnlAtoms == null
              ? null
              : Number(fromFixedPoint(risk.pnlAtoms * 1_000n, 6))
            : markUsable
              ? (Number(mark.price) - Number(position.entryPrice)) * size
              : null;

          let marginUsed: string | null = null;
          let liquidation: string | null = null;
          if (settings && settings.kind === "perp") {
            const estimate = positionCost(
              long ? "buy" : "sell",
              withoutSign(position.size),
              position.entryPrice,
              settings,
              limits.get(position.market),
            );
            const display = displayOrderCost(estimate, priceDecimals);
            marginUsed = display.initialMargin;
            liquidation = display.liquidationPrice;
          }
          const liquidationShown = risks
            ? liquidationCell(risk, priceDecimals)
            : {
                value:
                  liquidation !== null ? formatDecimal(liquidation, priceDecimals) : UNAVAILABLE,
                title: `Estimate: a ${percentOfBps(limits.get(position.market)?.mmBps ?? MAINTENANCE_MARGIN_BPS)} maintenance margin, computed on this device. Not confirmed by the exchange.`,
              };

          const leverageShown = leverageCell(
            risk ? leverageRatio(risk.notionalAtoms, risk.equityAtoms) : null,
            settings?.kind === "perp" ? settings.maxLeverage : null,
          );

          return (
            <li
              key={position.market}
              className="bg-surface-raised border-line-subtle rounded-tile border p-3"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span
                  className={`rounded-tile px-2 py-0.5 text-[12px] font-medium ${
                    long ? "bg-safe/15 text-safe" : "bg-danger/15 text-danger"
                  }`}
                >
                  {long ? "Long" : "Short"}
                </span>
                <span className="text-ink-strong text-[14px] font-medium">
                  {marketDisplayName(position.market)}
                </span>
                <span className="tnum text-dim text-[13px]">
                  {formatDecimal(Math.abs(size), sizeDecimals)}
                  {settings ? ` ${settings.base}` : ""}
                </span>
                <span
                  className="ml-auto text-right"
                  title={
                    risks
                      ? `What this position adds to your equity at the mark. It includes profit already taken by earlier partial closes and funding already settled, and leaves out fees and funding not yet settled.`
                      : undefined
                  }
                >
                  <span className="text-faint block text-[11px]">
                    {risks ? "Position P&L" : "Unrealised P&L"}
                  </span>
                  <span
                    className={`tnum text-[15px] font-medium ${
                      unrealised === null
                        ? "text-faint"
                        : unrealised >= 0
                          ? "text-safe"
                          : "text-danger"
                    }`}
                  >
                    {unrealised !== null
                      ? `${unrealised > 0 ? "+" : ""}${formatMoney(unrealised, quoteSymbol)}`
                      : "Price unavailable"}
                  </span>
                </span>
              </div>
              <dl className="tnum mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[13px] sm:grid-cols-4">
                <PositionStat
                  label={risks ? "Break-even" : "Entry"}
                  title={
                    risks
                      ? "The price at which this position's own cash flow nets to zero. It equals your average entry only while the position has never been reduced and no funding has been settled."
                      : undefined
                  }
                  value={
                    risks
                      ? risk?.breakEven != null
                        ? formatDecimal(
                            fromFixedPoint(risk.breakEven, priceDecimals),
                            priceDecimals,
                          )
                        : UNAVAILABLE
                      : formatDecimal(position.entryPrice, priceDecimals)
                  }
                />
                <PositionStat
                  label="Mark"
                  value={markUsable ? formatDecimal(mark!.price, priceDecimals) : UNAVAILABLE}
                />
                <PositionStat
                  label="Margin used (est.)"
                  value={marginUsed !== null ? formatMoney(marginUsed, quoteSymbol) : UNAVAILABLE}
                />
                <PositionStat
                  label="Liquidation (est.)"
                  title={liquidationShown.title}
                  value={liquidationShown.value}
                />
                {risk && (
                  <PositionStat
                    label="Leverage"
                    title={leverageShown.title}
                    value={leverageShown.value}
                  />
                )}
              </dl>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  className={`${btnGhost} flex-1 text-[12px]`}
                  onClick={() => onReduce(position)}
                >
                  Reduce
                </button>
                <button
                  type="button"
                  className={`${btnGhost} flex-1 text-[12px]`}
                  onClick={() => onClose(position)}
                >
                  Close position
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

export const UNREADABLE_EXPOSURE_NOTE =
  "This account holds a position or order in a market this terminal does not trade. Its size, margin and liquidation price cannot be shown, so those figures are unknown and orders that could add risk are off. You can still close positions here.";

function UnreadableExposureNote() {
  return (
    <p role="alert" className="text-warning mb-2 text-[12px]">
      {UNREADABLE_EXPOSURE_NOTE}
    </p>
  );
}

function PositionStat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div title={title}>
      <dt className="text-faint text-[11px]">{label}</dt>
      <dd className={title ? "text-ink underline decoration-dotted" : "text-ink"}>{value}</dd>
    </div>
  );
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex min-h-[96px] flex-col items-center justify-center gap-1 px-4 py-4 text-center">
      <p className="text-ink text-[13px] font-medium">{title}</p>
      <p className="text-faint text-[12px]">{hint}</p>
    </div>
  );
}

function OpenOrdersTable({
  openOrders,
  marketSettings,
  now,
  onCancel,
  cancellingOrderIds,
}: {
  openOrders: OpenOrder[];
  marketSettings: MarketSettingsLookup;
  now: number;
  onCancel: ((market: string, orderId: string) => void) | null;
  cancellingOrderIds: ReadonlySet<string>;
}) {
  if (openOrders.length === 0) {
    return (
      <EmptyState
        title="No open orders"
        hint="Orders that are still waiting to fill show up here, and you can cancel them."
      />
    );
  }
  return (
    <table className="tnum w-full text-left text-[13px]">
      <thead className="text-faint text-[11px] uppercase">
        <tr>
          <th className="font-normal">Market</th>
          <th className="font-normal">Side</th>
          <th className="font-normal">Type</th>
          <th className="font-normal">Price</th>
          <th className="font-normal">Remaining</th>
          <th className="font-normal">Expires</th>
          <th className="font-normal"></th>
        </tr>
      </thead>
      <tbody>
        {openOrders.map((order) => {
          const settings = marketSettings(order.market);
          return (
            <tr key={order.orderId} className="border-line-subtle border-t">
              <td className="py-1.5">{marketDisplayName(order.market)}</td>
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
              <td className="text-faint" title="When the order's own expiry passes">
                {order.expiresAtMs === undefined
                  ? UNAVAILABLE
                  : order.expiresAtMs === null
                    ? "Never"
                    : formatTimeLeft(order.expiresAtMs, now)}
              </td>
              <td className="py-1.5 text-right">
                {onCancel && (
                  <button
                    type="button"
                    className={`${btnGhost} px-2 text-[11px]`}
                    disabled={cancellingOrderIds.has(order.orderId)}
                    onClick={() => onCancel(order.market, order.orderId)}
                  >
                    {cancellingOrderIds.has(order.orderId)
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
  if (fills.length === 0) {
    return (
      <EmptyState
        title="No fills yet"
        hint="Your trades from this visit appear here as they fill."
      />
    );
  }
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
              <td className="py-1.5">{marketDisplayName(fill.market)}</td>
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
  quoteSymbol,
  onTransfer,
  now,
}: {
  balances: Balance[];
  collateral: Balance | null;
  quoteSymbol: string;
  onTransfer: TransferFn | null;
  now: number;
}) {
  const rows = [
    ...(collateral
      ? [
          {
            ...collateral,
            label: collateral.asset
              ? `${collateral.asset} (perpetuals collateral)`
              : "Perpetuals collateral",
            quote: true,
          },
        ]
      : []),
    ...balances.map((balance) => ({
      ...balance,
      label: balance.asset,
      quote: !!quoteSymbol && balance.asset === quoteSymbol,
    })),
  ];
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No balances yet"
        hint="Once your account is open and funded, your USDC shows up here."
      />
    );
  }
  const amount = (value: string, quote: boolean) =>
    quote ? formatMoney(value, quoteSymbol) : formatDecimal(value, 6);
  const availableCell = (row: (typeof rows)[number]) =>
    availableLabel(row, (value) => amount(value, row.quote), now);
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
          {rows.map((row) => (
            <tr key={row.label} className="border-line-subtle border-t">
              <td className="py-1.5">{row.label}</td>
              <td>{availableCell(row)}</td>
              <td>{isAvailableUnknown(row, now) ? "-" : amount(row.reserved, row.quote)}</td>
              <td>{amount(row.total, row.quote)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {onTransfer && collateral && (
        <TransferControl
          onTransfer={onTransfer}
          collateral={collateral}
          spot={balances.find((balance) => balance.asset === quoteSymbol) ?? null}
          quoteSymbol={quoteSymbol}
        />
      )}
    </>
  );
}

function MarginTable({
  positions,
  collateral,
  marksByMarket,
  now,
  marketSettings,
  quoteSymbol,
  limits,
  exposureUnreadable,
}: {
  positions: Position[];
  collateral: Balance | null;
  marksByMarket: Record<string, { price: string; time: number } | null>;
  now: number;
  marketSettings: MarketSettingsLookup;
  quoteSymbol: string;
  limits: ReadonlyMap<string, MarketLimits>;
  exposureUnreadable: boolean;
}) {
  const risks = exposureUnreadable
    ? unknownPositionRisks(positions)
    : positionRisks(positions, collateral?.total ?? null, freshMarkLookup(marksByMarket, now));
  const perpPositions = positions.filter((position) => {
    const settings = marketSettings(position.market);
    return Number(position.size) !== 0 && settings?.kind === "perp";
  });
  if (perpPositions.length === 0) {
    if (exposureUnreadable) return <UnreadableExposureNote />;
    return (
      <EmptyState
        title="No margin in use"
        hint="Margin is the collateral held against an open position. It appears here once you have one."
      />
    );
  }
  const accountLeverageShown = leverageCell(risks ? accountLeverage(risks) : null, null);
  const noted = limits.get(perpPositions[0].market);
  const noteFee = percentOfBps(noted?.takerFeeBps ?? ASSUMED_TAKER_FEE_BPS);
  const noteMaintenance = percentOfBps(noted?.mmBps ?? MAINTENANCE_MARGIN_BPS);
  return (
    <>
      {exposureUnreadable && <UnreadableExposureNote />}
      <table className="tnum w-full text-left text-[13px]">
        <thead className="text-faint text-[11px] uppercase">
          <tr>
            <th className="font-normal">Market</th>
            <th className="font-normal">Margin at max leverage (est.)</th>
            <th className="font-normal">
              {risks ? "Est. liquidation" : "Closest est. liquidation"}
            </th>
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
            const estimate = positionCost(
              size > 0 ? "buy" : "sell",
              withoutSign(position.size),
              position.entryPrice,
              settings,
              limits.get(position.market),
            );
            const display = displayOrderCost(estimate, priceDecimalsOf(settings));
            return (
              <tr key={position.market} className="border-line-subtle border-t">
                <td className="py-1.5">{marketDisplayName(position.market)}</td>
                <td>{formatMoney(display.initialMargin, quoteSymbol)}</td>
                <td>
                  {risks
                    ? liquidationCell(risks.get(position.market), priceDecimalsOf(settings)).value
                    : display.liquidationPrice
                      ? formatDecimal(display.liquidationPrice, priceDecimalsOf(settings))
                      : UNAVAILABLE}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {risks && (
        <p className="text-dim tnum mt-2 text-[13px]" title={accountLeverageShown.title}>
          Account leverage{" "}
          <span className="text-ink underline decoration-dotted">{accountLeverageShown.value}</span>
        </p>
      )}
      <p className={`${sectionLabel} mt-2`}>Estimate, not a guarantee</p>
      <p className="text-faint mt-1 text-[11px] leading-relaxed">
        {risks
          ? `Liquidation prices use your collateral, all your open positions and each market's own maintenance margin, worked out on this device. ${FUNDING_NOTE} Margin at max leverage assumes a ${noteFee} trading fee. The exchange decides the real threshold.`
          : `These figures are worked out on this device from your entry price. They assume a ${noteMaintenance} maintenance margin as the liquidation threshold and a ${noteFee} trading fee. The exchange decides the real threshold.`}
      </p>
    </>
  );
}
