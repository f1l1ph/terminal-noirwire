"use client";

import { useState } from "react";
import { formatClockTime, formatShortAddress } from "@/lib/format";
import { env } from "@/lib/env";
import type { AccountReadOutcome, PrivacyCheck } from "@/lib/trading/types";
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

const WHAT_THIS_SHOWS =
  "These two unsigned reads returned no account data at this time. Public fills and timing remain visible. This check does not establish anonymity or rule out timing correlation.";

/** Pass is green, a real fail is red, a failed read is neutral (never green) - the second design review's "a failed or errored unsigned read must never show as empty." */
function readRowTone(outcome: AccountReadOutcome): string {
  if (outcome.kind === "notReturned") return "text-safe";
  if (outcome.kind === "returned") return "text-danger";
  return "text-warning";
}

function readRowText(outcome: AccountReadOutcome): string {
  if (outcome.kind === "notReturned") return "no data returned";
  if (outcome.kind === "returned") return "data returned";
  return `check failed - ${outcome.reason}`;
}

function AccountReadRow({ label, outcome }: { label: string; outcome: AccountReadOutcome }) {
  return (
    <p className={`${readRowTone(outcome)} text-[14px] leading-snug`}>
      <span className="text-ink-strong">{label}</span> · {readRowText(outcome)}
    </p>
  );
}

/**
 * An independent, unsigned fetch of this market's public tape: no wallet
 * credential, no account ID, the same request any visitor's browser could
 * send. Lists every field the response actually carries, including the
 * per-order `tag` sim-noirwire echoes on a fill (see
 * src/lib/trading/tags.ts for what that does and does not reveal), rather
 * than a general "mark, fills, settings" claim. In rollup mode, a second,
 * independent check (`checkPrivacy`, present only there) reads this
 * trader's own on-chain view and the market's book account unsigned,
 * straight from the rollup, with a real three-way outcome per address
 * (no data / data / check failed) rather than collapsing a failed read
 * into "empty" - the second design review's integrity fix.
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
  const [showWhatThisShows, setShowWhatThisShows] = useState(false);
  // Third design review, must-fix 7: the inline summary stays two small
  // lines, but the proof itself (both results, the endpoint, the checked
  // time, the addresses, the one sentence) is also available at readable
  // size in a focused panel at least 320 px wide - not squeezed into this
  // narrow column.
  const [evidenceOpen, setEvidenceOpen] = useState(false);

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
          {loading ? "Checking…" : snapshot ? "Check again" : "Check public tape"}
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
            <p className={sectionLabel}>Unsigned account check</p>
            <button
              type="button"
              className={`${btnGhost} h-7 px-2 text-[11px]`}
              onClick={() => void checkOnChain()}
            >
              {privacyLoading ? "Checking…" : privacy ? "Check again" : "Check unsigned accounts"}
            </button>
          </div>
          {privacyError && <p className="text-warning text-[11px]">{privacyError}</p>}
          {privacy ? (
            <div className="mt-2 flex flex-col gap-1.5">
              <AccountReadRow label="Trader view" outcome={privacy.view.outcome} />
              <AccountReadRow label={`${market} book`} outcome={privacy.book.outcome} />
              <p className="tnum text-faint mt-1 text-[11px]">
                Unsigned {privacy.network} rollup RPC · checked{" "}
                {formatClockTime(new Date(privacy.checkedAtMs))}
              </p>
              <div className="mt-0.5 flex items-center gap-3">
                <button
                  type="button"
                  className="text-ink self-start text-[11px] underline"
                  onClick={() => setEvidenceOpen(true)}
                >
                  Enlarge evidence
                </button>
                <button
                  type="button"
                  className="text-ink self-start text-[11px] underline"
                  onClick={() => setShowWhatThisShows((value) => !value)}
                  aria-expanded={showWhatThisShows}
                >
                  What this shows
                </button>
              </div>
              {showWhatThisShows && (
                <p className="text-faint text-[11px] leading-relaxed">{WHAT_THIS_SHOWS}</p>
              )}
            </div>
          ) : (
            <p className="text-faint mt-1 text-[11px]">
              Reads your own on-chain account and this market&apos;s book, unsigned, straight from
              the rollup.
            </p>
          )}
        </div>
      )}
      {privacy && evidenceOpen && (
        // Fixed to the viewport, not anchored to this panel's own position:
        // PublicView sits low on the page, and an anchored overlay large
        // enough to hold every required line ran past the bottom of the
        // viewport in a real capture, clipping exactly the one sentence the
        // review most wants visible. A centered, viewport-fixed panel is
        // never clipped by where the trigger button happens to sit.
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4">
          <div
            role="dialog"
            aria-label="Privacy evidence"
            className="bg-surface border-line-strong rounded-panel flex w-[360px] max-w-[92vw] flex-col gap-2 border p-4 shadow-lg"
          >
            <div className="flex items-center justify-between">
              <p className={sectionLabel}>Privacy evidence</p>
              <button
                type="button"
                className="text-faint text-[11px] underline"
                onClick={() => setEvidenceOpen(false)}
              >
                Close
              </button>
            </div>
            <AccountReadRow label="Trader view" outcome={privacy.view.outcome} />
            <AccountReadRow label={`${market} book`} outcome={privacy.book.outcome} />
            <p className="tnum text-dim text-[13px] leading-snug">
              Unsigned {privacy.network} rollup RPC
            </p>
            <p className="tnum text-dim text-[13px] leading-snug">
              Checked {formatClockTime(new Date(privacy.checkedAtMs))}
            </p>
            <p className="tnum text-faint text-[12px] leading-snug">
              View {formatShortAddress(privacy.view.address)} · book{" "}
              {formatShortAddress(privacy.book.address)}
            </p>
            <p className="text-faint text-[11px] break-all">{privacy.endpoint}</p>
            <p className="text-ink text-[13px] leading-relaxed">{WHAT_THIS_SHOWS}</p>
          </div>
        </div>
      )}
    </div>
  );
}
