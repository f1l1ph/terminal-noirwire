import { formatDecimal, formatMoney, UNAVAILABLE } from "@/lib/format";
import type { OrderCostEstimateDisplay } from "@/lib/trading/risk";
import type { Side } from "@/lib/trading/types";

export function OrderSummary({
  isPerp,
  display,
  priceDecimals,
  remainingAvailable,
  quoteSymbol,
}: {
  side: Side;
  isPerp: boolean;
  display: OrderCostEstimateDisplay | null;
  priceDecimals: number;
  remainingAvailable: string | null;
  quoteSymbol: string;
}) {
  const money = (value: string) => formatMoney(value, quoteSymbol);
  if (!display) {
    return (
      <p className="border-line-subtle text-dim border-t border-b py-2 text-[13px]">
        Enter quantity to see estimate.
      </p>
    );
  }

  const rows: { label: string; value: string }[] = [
    { label: "Notional", value: money(display.notional) },
    { label: "Fee", value: money(display.fee) },
  ];
  if (isPerp) {
    rows.push({ label: "Margin", value: money(display.initialMargin) });
    rows.push({
      label: "Liquidation (est.)",
      value: display.liquidationPrice
        ? formatDecimal(display.liquidationPrice, priceDecimals)
        : UNAVAILABLE,
    });
  }
  rows.push({
    label: "Remaining",
    value: remainingAvailable ? money(remainingAvailable) : UNAVAILABLE,
  });

  return (
    <dl className="border-line-subtle flex flex-col gap-0.5 border-t border-b py-1 text-[13px]">
      {rows.map((row) => (
        <div key={row.label} className="flex justify-between gap-2">
          <dt className="text-faint">{row.label}</dt>
          <dd className="tnum text-ink">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
