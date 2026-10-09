"use client";

import { useState } from "react";
import { formatDuration, formatRelativeAge } from "@/lib/format";
import { ageMs, latencyDisplay } from "@/lib/market-data/selectors";
import { MIN_LATENCY_SAMPLE_SIZE, type StatsResponse } from "@/lib/market-data/types";
import { env } from "@/lib/env";
import { panel } from "@/components/ui/styles";

export function VenuePulse({ stats, now }: { stats: StatsResponse | null; now: number }) {
  const [showMethod, setShowMethod] = useState(false);
  const display = latencyDisplay(stats, now);

  // The network label is shown elsewhere on screen already (the top bar,
  // the status bar); repeating it here was most of why this line wrapped to
  // several rows in a 212 px column (second-pass review). Two short lines
  // instead of one long one.
  let primaryLine: string;
  let secondaryLine: string;
  if (display.status === "ok") {
    const age = ageMs(display.updatedAtMs, now);
    primaryLine = `p50 ${formatDuration(display.p50Ms)} · p99 ${formatDuration(display.p99Ms)}`;
    secondaryLine = `n=${display.sampleSize}${age !== null ? ` · ${formatRelativeAge(age)} ago` : ""}`;
  } else if (display.status === "insufficient") {
    primaryLine = env.networkLabel;
    secondaryLine = `Insufficient samples (${display.sampleSize})`;
  } else {
    primaryLine = env.networkLabel;
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
          this says so instead of a number it cannot back.
        </p>
      )}
    </div>
  );
}
