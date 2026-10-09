import { formatDuration, formatEventTime } from "@/lib/format";
import { latencyDisplay } from "@/lib/market-data/selectors";
import type { VenueStats } from "@/lib/market-data/types";
import { panel } from "@/components/ui/styles";

export function VenuePulse({ stats, now }: { stats: VenueStats | null; now: number }) {
  const display = latencyDisplay(stats, now);
  return (
    <div className={`${panel} p-4`}>
      <p className="text-faint text-[11px] tracking-wide uppercase">Venue pulse</p>
      {display.status === "ok" && (
        <>
          <p className="tnum text-ink mt-2 text-[14px]">
            Confirmation p50 {formatDuration(display.p50Ms)} · p99 {formatDuration(display.p99Ms)}
          </p>
          <p className="text-faint mt-1 text-[12px]">
            {display.sampleCount} orders · last updated{" "}
            {formatEventTime(new Date(display.updatedAt), new Date(now))}
          </p>
        </>
      )}
      {display.status === "insufficient" && (
        <p className="text-dim mt-2 text-[13px]">Insufficient samples ({display.sampleCount})</p>
      )}
      {display.status === "unavailable" && (
        <p className="text-warning mt-2 text-[13px]">
          Measurement unavailable
          {display.lastValidAt !== null
            ? ` · last valid ${formatEventTime(new Date(display.lastValidAt), new Date(now))}`
            : ""}
        </p>
      )}
      <p className="text-faint mt-3 text-[11px] leading-relaxed">
        How measured: first authoritative venue response to an order, placement to confirmation,
        accepted and rejected orders together.
      </p>
    </div>
  );
}
