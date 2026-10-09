import { formatDecimal, formatMoney, UNAVAILABLE } from "@/lib/format";
import type { OrderCostEstimateDisplay } from "@/lib/trading/risk";
import type { Side } from "@/lib/trading/types";

export function OrderSummary({
  isPerp,
  display,
  priceDecimals,
  remainingAvailable,
  now,
}: {
  side: Side;
  isPerp: boolean;
  display: OrderCostEstimateDisplay | null;
  priceDecimals: number;
  remainingAvailable: string | null;
  now: number;
}) {
  if (!display) {
    return (
      <p className="border-line-subtle text-dim border-t border-b py-3 text-[13px]">
        Enter quantity to see estimate.
      </p>
    );
  }

  const rows: { label: string; value: string }[] = [
    { label: "Estimated notional", value: formatMoney(display.notional) },
    { label: "Fee (est.)", value: formatMoney(display.fee) },
  ];
  if (isPerp) {
    rows.push({ label: "Initial margin (est.)", value: formatMoney(display.initialMargin) });
    rows.push({
      label: "Est. liquidation",
      value: display.liquidationPrice
        ? formatDecimal(display.liquidationPrice, priceDecimals)
        : UNAVAILABLE,
    });
  }
  rows.push({
    label: "Remaining available",
    value: remainingAvailable ? formatMoney(remainingAvailable) : UNAVAILABLE,
  });

  return (
    <dl className="border-line-subtle flex flex-col gap-1.5 border-t border-b py-3 text-[13px]">
      {rows.map((row) => (
        <div key={row.label} className="flex justify-between">
          <dt className="text-faint">{row.label}</dt>
          <dd className="tnum text-ink">{row.value}</dd>
        </div>
      ))}
      {isPerp && (
        <p className="text-faint text-[11px]">
          Liquidation estimate: half the market&apos;s implied initial margin, this device,{" "}
          {new Date(now).toLocaleTimeString()}. Not a venue-confirmed threshold.
        </p>
      )}
    </dl>
  );
}
