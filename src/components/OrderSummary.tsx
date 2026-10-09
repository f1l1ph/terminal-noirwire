import { formatDuration, formatMoney, formatPrice, UNAVAILABLE } from "@/lib/format";
import { env } from "@/lib/env";
import type { OrderCostEstimateDisplay } from "@/lib/trading/risk";
import type { OrderSide } from "@/lib/trading/types";

export function OrderSummary({
  side,
  isPerp,
  display,
  markAgeMs,
}: {
  side: OrderSide;
  isPerp: boolean;
  display: OrderCostEstimateDisplay | null;
  markAgeMs: number | null;
}) {
  const rows: { label: string; value: string }[] = [
    { label: "Quantity cost", value: display ? formatMoney(display.notional) : UNAVAILABLE },
    { label: "Fee", value: display ? formatMoney(display.fee) : UNAVAILABLE },
  ];
  if (isPerp) {
    rows.push({
      label: "Initial margin (est.)",
      value: display ? formatMoney(display.initialMargin) : UNAVAILABLE,
    });
    rows.push({
      label: "Est. liquidation",
      value: display?.liquidationPrice ? formatPrice(display.liquidationPrice, 2) : UNAVAILABLE,
    });
  }
  return (
    <dl className="border-line-subtle flex flex-col gap-1.5 border-t border-b py-3 text-[13px]">
      {rows.map((row) => (
        <div key={row.label} className="flex justify-between">
          <dt className="text-faint">{row.label}</dt>
          <dd className="tnum text-ink">{row.value}</dd>
        </div>
      ))}
      <div className="flex justify-between">
        <dt className="text-faint">Mark age</dt>
        <dd className="tnum text-dim">
          {markAgeMs === null ? UNAVAILABLE : formatDuration(markAgeMs)}
        </dd>
      </div>
      <p className="text-faint pt-1 text-[11px]">
        Execution price may differ. {side === "buy" ? "Buy" : "Sell"} on {env.networkLabel}.
      </p>
    </dl>
  );
}
