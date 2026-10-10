"use client";

import { useState } from "react";
import { formatDuration, formatRelativeAge, networkDisplayLabel } from "@/lib/format";
import { ageMs, latencyDisplay } from "@/lib/market-data/selectors";
import { MIN_LATENCY_SAMPLE_SIZE, type StatsResponse } from "@/lib/market-data/types";
import { panel } from "@/components/ui/styles";

/**
 * Third design review, must-fix 3: the first evidence card must lead with
 * this browser's own order speed, not the venue's accept/reject
 * distribution - a multi-second p99 in that spot reads like the venue's
 * normal order speed. The venue distribution (still p50/p99/n/server clock,
 * wording per the second design review) moves behind "Venue timing
 * details"; it is never the headline, however it reads.
 */
export function VenuePulse({
  stats,
  now,
  network,
  clientDurationMs,
}: {
  stats: StatsResponse | null;
  now: number;
  /** The rollup deployment's own network field ("localnet"/"devnet"); "localnet" for dev mode, which is always an in-memory local engine. */
  network: string;
  /** This browser's own last order click-to-result, `useTrading`'s measurement; null before the first order this session. */
  clientDurationMs: number | null;
}) {
  const [showMethod, setShowMethod] = useState(false);
  const display = latencyDisplay(stats, now);
  const networkLabel = networkDisplayLabel(network);

  const headline =
    clientDurationMs === null
      ? `${networkLabel} order timing appears after your first order`
      : `This order · click to result ${formatDuration(clientDurationMs)}`;
  const headlineDetail =
    clientDurationMs === null
      ? "Measured on this browser from the submit click to the venue's own result."
      : "Submit click to the venue's own result, this browser's clock.";

  let venueLine: string;
  let venueDetail: string;
  if (display.status === "ok") {
    const age = ageMs(display.updatedAtMs, now);
    venueLine = `${networkLabel} · venue response p50 ${formatDuration(display.p50Ms)} · p99 ${formatDuration(display.p99Ms)} · n=${display.sampleSize}`;
    venueDetail = `Accept or reject, server clock · updated ${age !== null ? formatRelativeAge(age) : "unavailable"}`;
  } else if (display.status === "insufficient") {
    venueLine = networkLabel;
    venueDetail = `Insufficient samples (${display.sampleSize})`;
  } else {
    venueLine = networkLabel;
    venueDetail = "Measurement unavailable";
  }

  return (
    <div className={`${panel} flex flex-col gap-0.5 px-3 py-2`}>
      <p className="tnum text-ink text-[12px] leading-tight">{headline}</p>
      <p className="text-faint text-[11px] leading-tight">{headlineDetail}</p>
      <button
        type="button"
        className="text-faint mt-1 shrink-0 self-start text-[11px] underline"
        onClick={() => setShowMethod((value) => !value)}
        aria-expanded={showMethod}
      >
        Venue timing details
      </button>
      {showMethod && (
        <div className="border-line-subtle mt-1 flex flex-col gap-0.5 border-t pt-1">
          <p className="tnum text-dim text-[11px] leading-tight">{venueLine}</p>
          <p className="tnum text-faint text-[11px] leading-tight">{venueDetail}</p>
          <p className="text-faint text-[11px] leading-relaxed">
            Confirmation is the time from an order reaching the venue to its first accept-or-reject
            response, accepted and rejected orders together, measured server-side
            {display.status === "ok" ? ` (${display.measuredFrom})` : ""}. Shown only at or above{" "}
            {MIN_LATENCY_SAMPLE_SIZE} samples from a reading updated in the last 30 seconds;
            otherwise this says so instead of a number it cannot back. This is a venue accept/reject
            percentile on the {networkLabel} network, not an end-to-end public-network fill time,
            and never this order&apos;s own speed above.
          </p>
        </div>
      )}
    </div>
  );
}
