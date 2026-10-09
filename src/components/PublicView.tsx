"use client";

import { useState } from "react";
import { formatClockTime } from "@/lib/format";
import { env } from "@/lib/env";
import { btnGhost, panel, sectionLabel } from "@/components/ui/styles";

interface PublicSnapshot {
  fetchedAt: number;
  responseMs: number;
  raw: unknown;
  fieldsReturned: string[];
}

const TAPE_FIELDS = [
  "market",
  "price",
  "size",
  "takerSide",
  "takerTag",
  "makerTag",
  "timestampMs",
  "sequence",
];

/**
 * An independent, unsigned fetch of this market's public tape: no wallet
 * credential, no account ID, the same request any visitor's browser could
 * send. Lists every field the response actually carries, including the
 * per-order `tag` sim-noirwire echoes on a fill (see
 * src/lib/trading/tags.ts for what that does and does not reveal), rather
 * than a general "mark, fills, settings" claim.
 */
export function PublicView({ market }: { market: string }) {
  const [snapshot, setSnapshot] = useState<PublicSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const requestUrl = `${env.simUrl}/v1/tape?market=${encodeURIComponent(market)}&limit=5`;

  async function check() {
    setLoading(true);
    setError(null);
    const startedAt = performance.now();
    try {
      const response = await fetch(requestUrl, { headers: { accept: "application/json" } });
      const responseMs = performance.now() - startedAt;
      if (!response.ok) throw new Error(`Answered ${response.status}`);
      const raw = await response.json();
      setSnapshot({ fetchedAt: Date.now(), responseMs, raw, fieldsReturned: TAPE_FIELDS });
      setOpen(true);
    } catch {
      setError("Public evidence unavailable");
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={`${panel} relative flex flex-col gap-1 p-3`}>
      <div className="flex items-center justify-between">
        <p className={sectionLabel}>Public view</p>
        <button
          type="button"
          className={`${btnGhost} h-7 px-2 text-[11px]`}
          onClick={() => void check()}
        >
          {loading ? "Checking…" : snapshot ? "Check again" : "Check"}
        </button>
      </div>
      {error && <p className="text-warning text-[11px]">{error}</p>}
      {snapshot ? (
        <button
          type="button"
          className="tnum text-dim text-left text-[11px] underline"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          Checked at {formatClockTime(new Date(snapshot.fetchedAt))} {"·"}{" "}
          {Math.round(snapshot.responseMs)} ms, unsigned
        </button>
      ) : (
        <p className="text-faint text-[11px]">
          An unsigned fetch of this market&apos;s public tape.
        </p>
      )}
      {snapshot && open && (
        <div className="bg-surface border-line-strong rounded-panel absolute inset-x-0 top-full z-10 mt-1 flex flex-col gap-2 border p-3 shadow-lg">
          <p className="text-faint text-[11px] break-all">{requestUrl}</p>
          <p className="text-faint text-[11px]">
            Fields returned: {snapshot.fieldsReturned.join(", ")}. No account identity, balance,
            position or order is in this response; this check only shows what this unsigned endpoint
            returned at the time above, not a proof against every correlation path.
          </p>
          <pre className="bg-surface-raised rounded-tile text-dim max-h-[220px] overflow-auto p-2 text-[11px]">
            {JSON.stringify(snapshot.raw, null, 2)}
          </pre>
          <button
            type="button"
            className="text-ink self-start text-[11px] underline"
            onClick={() => setOpen(false)}
          >
            Close
          </button>
        </div>
      )}
    </div>
  );
}
