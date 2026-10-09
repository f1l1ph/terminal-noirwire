"use client";

import { useState } from "react";
import { formatClockTime } from "@/lib/format";
import { env } from "@/lib/env";
import type { PrivacyCheck } from "@/lib/trading/types";
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
 * than a general "mark, fills, settings" claim. In rollup mode, a second,
 * independent check (`checkPrivacy`, present only there) reads this
 * trader's own on-chain view and the market's book account unsigned,
 * straight from the rollup, and shows both coming back empty - the actual
 * mechanism behind "nobody but the program can read the book," not just a
 * claim about it.
 */
export function PublicView({
  market,
  checkPrivacy,
}: {
  market: string;
  checkPrivacy?: ((market: string) => Promise<PrivacyCheck | null>) | null;
}) {
  const [snapshot, setSnapshot] = useState<PublicSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const requestUrl = `${env.simUrl}/v1/tape?market=${encodeURIComponent(market)}&limit=5`;

  const [privacy, setPrivacy] = useState<PrivacyCheck | null>(null);
  const [privacyError, setPrivacyError] = useState<string | null>(null);
  const [privacyLoading, setPrivacyLoading] = useState(false);

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

  async function checkOnChain() {
    if (!checkPrivacy) return;
    setPrivacyLoading(true);
    setPrivacyError(null);
    try {
      const result = await checkPrivacy(market);
      if (!result) throw new Error("not available");
      setPrivacy(result);
    } catch {
      setPrivacyError("On-chain check unavailable");
      setPrivacy(null);
    } finally {
      setPrivacyLoading(false);
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
      {checkPrivacy && (
        <div className="border-line-subtle mt-1 border-t pt-1.5">
          <div className="flex items-center justify-between">
            <p className={sectionLabel}>On-chain accounts</p>
            <button
              type="button"
              className={`${btnGhost} h-7 px-2 text-[11px]`}
              onClick={() => void checkOnChain()}
            >
              {privacyLoading ? "Checking…" : privacy ? "Check again" : "Check"}
            </button>
          </div>
          {privacyError && <p className="text-warning text-[11px]">{privacyError}</p>}
          {privacy ? (
            <div className="tnum mt-1 flex flex-col gap-0.5 text-[11px]">
              <p className={privacy.viewEmpty ? "text-safe" : "text-danger"}>
                Your view account, read unsigned: {privacy.viewEmpty ? "empty" : "NOT empty"}
              </p>
              <p className={privacy.bookEmpty ? "text-safe" : "text-danger"}>
                This market&apos;s book, read unsigned: {privacy.bookEmpty ? "empty" : "NOT empty"}
              </p>
              <p className="text-faint">
                Same unsigned connection as the tape above, reading two addresses this account
                should never expose: your own trading account and the book&apos;s resting orders.
              </p>
            </div>
          ) : (
            <p className="text-faint mt-1 text-[11px]">
              Reads your own on-chain account and this market&apos;s book, unsigned, straight from
              the rollup - both should come back empty.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
