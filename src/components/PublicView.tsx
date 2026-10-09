"use client";

import { useState } from "react";
import { formatClockTime } from "@/lib/format";
import { env } from "@/lib/env";
import { btnGhost, panel } from "@/components/ui/styles";

interface PublicSnapshot {
  fetchedAt: number;
  responseMs: number;
  raw: unknown;
}

export function PublicView({ market }: { market: string }) {
  const [snapshot, setSnapshot] = useState<PublicSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const requestUrl = `${env.simUrl}/v1/markets`;

  async function check() {
    setLoading(true);
    setError(null);
    const startedAt = performance.now();
    try {
      // Independently fetched: no wallet credential, no account ID, the same
      // request shape any visitor's browser would send.
      const response = await fetch(requestUrl, { headers: { accept: "application/json" } });
      const responseMs = performance.now() - startedAt;
      if (!response.ok) throw new Error(`Answered ${response.status}`);
      const raw = await response.json();
      setSnapshot({ fetchedAt: Date.now(), responseMs, raw });
    } catch {
      setError("Public evidence unavailable");
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={`${panel} flex flex-col gap-3 p-4`}>
      <div className="flex items-center justify-between">
        <p className="text-faint text-[11px] tracking-wide uppercase">Public view</p>
        <button
          type="button"
          className={`${btnGhost} h-8 px-3 text-[12px]`}
          onClick={() => void check()}
        >
          {loading ? "Checking…" : snapshot ? "Check again" : "Check"}
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3 text-[12px]">
        <div>
          <p className="text-dim">Public</p>
          <p className="text-faint">mark, anonymous fills, aggregate counters, market settings</p>
        </div>
        <div>
          <p className="text-dim">Only you</p>
          <p className="text-faint">balances, positions, open orders, margin, own fills</p>
        </div>
      </div>
      <p className="text-faint text-[11px] break-all">{requestUrl}</p>
      {error && <p className="text-warning text-[12px]">{error}</p>}
      {snapshot && (
        <>
          <p className="tnum text-dim text-[12px]">
            Checked at {formatClockTime(new Date(snapshot.fetchedAt))} ·{" "}
            {Math.round(snapshot.responseMs)} ms for market {market}
          </p>
          <button
            type="button"
            className="text-ink self-start text-[12px] underline"
            onClick={() => setShowRaw((value) => !value)}
          >
            {showRaw ? "Hide raw response" : "View raw response"}
          </button>
          {showRaw && (
            <pre className="bg-surface-raised rounded-tile text-dim max-h-[200px] overflow-auto p-3 text-[11px]">
              {JSON.stringify(snapshot.raw, null, 2)}
            </pre>
          )}
        </>
      )}
    </div>
  );
}
