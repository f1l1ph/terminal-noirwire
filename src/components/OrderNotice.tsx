import { formatClockTime } from "@/lib/format";
import {
  describeOrder,
  STEP_LABELS,
  type OrderDescriptor,
  type RailStep,
} from "@/components/WitnessRail";

/**
 * The outcome of the last order in one quiet line, for the layouts that keep
 * the full order log out of the main view: a rejection or an unknown result
 * must never be visible only inside a hidden panel.
 */
export function OrderNotice({
  order,
  steps,
}: {
  order: OrderDescriptor | null;
  steps: RailStep[];
}) {
  const last = steps.at(-1);
  if (!order || !last) return null;
  const problem = last.type === "rejected";
  const showDetail =
    last.detail &&
    (last.type === "rejected" || last.type === "cancelled" || last.type === "unknown");
  return (
    <div
      className="bg-surface-raised rounded-tile flex flex-col gap-0.5 px-3 py-2 text-[12px]"
      role={problem ? "alert" : "status"}
    >
      <p className="text-dim">Last order · {describeOrder(order)}</p>
      <p className={problem ? "text-danger font-medium" : "text-ink font-medium"}>
        {STEP_LABELS[last.type]}
        <span className="tnum text-faint ml-2 font-normal">
          {formatClockTime(new Date(last.at))}
        </span>
      </p>
      {showDetail && <p className={problem ? "text-danger" : "text-faint"}>{last.detail}</p>}
    </div>
  );
}
