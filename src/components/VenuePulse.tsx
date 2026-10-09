"use client";

import { useState } from "react";
import { formatDuration, formatRelativeAge, networkDisplayLabel } from "@/lib/format";
import { ageMs, latencyDisplay } from "@/lib/market-data/selectors";
import { MIN_LATENCY_SAMPLE_SIZE, type StatsResponse } from "@/lib/market-data/types";
import { panel } from "@/components/ui/styles";

/**
 * Wording per the second design review, section 4: this is a server-clock
 * accept/reject percentile, measured on whichever network the deployment
 * actually is (local by default; see `networkDisplayLabel`) - never
 * presented as a public-network fill percentile, and never shown without
 * naming that network.
 */
export function VenuePulse({
  stats,
  now,
  network,
}: {
  stats: StatsResponse | null;
  now: number;
  /** The rollup deployment's own network field ("localnet"/"devnet"); "localnet" for dev mode, which is always an in-memory local engine. */
  network: string;
}) {
  const [showMethod, setShowMethod] = useState(false);
  const display = latencyDisplay(stats, now);
  const networkLabel = networkDisplayLabel(network);

  let primaryLine: string;
  let secondaryLine: string;
  if (display.status === "ok") {
    const age = ageMs(display.updatedAtMs, now);
    primaryLine = `${networkLabel} · venue response p50 ${formatDuration(display.p50Ms)} · p99 ${formatDuration(display.p99Ms)} · n=${display.sampleSize}`;
    secondaryLine = `Accept or reject, server clock · updated ${age !== null ? formatRelativeAge(age) : "unavailable"}`;
  } else if (display.status === "insufficient") {
    primaryLine = networkLabel;
    secondaryLine = `Insufficient samples (${display.sampleSize})`;
  } else {
    primaryLine = networkLabel;
    secondaryLine = "Measurement unavailable";
  }

  return (
    <div className={`${panel} flex flex-col gap-0.5 px-3 py-2`}>
      <p className="tnum text-ink text-[12px] leading-tight">{primaryLine}</p>
      <div className="flex items-center justify-between gap-2">
        <p className="tnum text-faint text-[11px] leading-tight">{secondaryLine}</p>
        <button
          type="button"
          className="text-faint shrink-0 text-[11px] underline"
          onClick={() => setShowMethod((value) => !value)}
          aria-expanded={showMethod}
        >
          How measured
        </button>
      </div>
      {showMethod && (
        <p className="text-faint text-[11px] leading-relaxed">
          Confirmation is the time from an order reaching the venue to its first accept-or-reject
          response, accepted and rejected orders together, measured server-side
          {display.status === "ok" ? ` (${display.measuredFrom})` : ""}. Shown only at or above{" "}
          {MIN_LATENCY_SAMPLE_SIZE} samples from a reading updated in the last 30 seconds; otherwise
          this says so instead of a number it cannot back. This is a venue accept/reject percentile
          on the {networkLabel} network, not an end-to-end public-network fill time.
        </p>
      )}
    </div>
  );
}
