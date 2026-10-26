export interface SummaryRow {
  label: string;
  value: string;
}

export function OrderSummary({ rows }: { rows: SummaryRow[] | null }) {
  if (!rows) {
    return <p className="text-faint text-[12px]">Enter an amount to see your order.</p>;
  }

  return (
    <dl className="border-line-subtle flex flex-col gap-1.5 border-t pt-3 text-[13px]">
      {rows.map((row) => (
        <div key={row.label} className="flex justify-between gap-3">
          <dt className="text-faint">{row.label}</dt>
          <dd className="tnum text-ink text-right">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
