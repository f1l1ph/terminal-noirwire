"use client";

import { useState } from "react";
import {
  describeOpenOutcome,
  keysMayNotPersist,
  keysNotice,
  recheckOffer,
} from "@/lib/trading/openCopy";
import type { AccountStatus, OpenAccountOutcome, OrderKeyState } from "@/lib/trading/types";
import { btnGhost, btnPrimary, input } from "@/components/ui/styles";

const TONE_CLASS = { ok: "text-dim", wait: "text-warning", error: "text-danger" } as const;

/**
 * Mainnet only: the connected address, opening the account with the invite
 * NoirWire issued for it, and where this device's trading keys stand.
 */
export function AccountSetup({
  address,
  status,
  needsInvite,
  opening,
  outcome,
  onOpen,
  onRecheck,
  keys,
  now,
}: {
  address: string;
  status: AccountStatus;
  needsInvite: boolean;
  opening: boolean;
  outcome: OpenAccountOutcome | null;
  onOpen: (invite?: string) => void;
  /** Runs the account check (and any key setup a failed attempt left undone) again. */
  onRecheck: () => Promise<void>;
  keys: OrderKeyState | null;
  now: number;
}) {
  const [invite, setInvite] = useState("");
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const notice = outcome ? describeOpenOutcome(outcome, status) : null;
  const keyStep = keysNotice(keys, now);
  const offer = recheckOffer(status, keys);
  const [checking, setChecking] = useState(false);

  function copyAddress() {
    navigator.clipboard.writeText(address).then(
      () => setCopied("yes"),
      () => setCopied("no"),
    );
  }

  return (
    <div className="border-line-subtle flex flex-col gap-1 border-b pb-1.5">
      <div className="flex items-center gap-2">
        <span className="text-faint text-[12px]">Wallet</span>
        <span className="tnum text-ink min-w-0 flex-1 truncate text-[12px]" title={address}>
          {address}
        </span>
        <button type="button" className={`${btnGhost} h-7 px-2 text-[11px]`} onClick={copyAddress}>
          {copied === "yes" ? "Copied" : copied === "no" ? "Copy failed" : "Copy"}
        </button>
      </div>

      {needsInvite && (
        <div className="flex flex-col gap-1">
          <label className="text-faint text-[12px]" htmlFor="open-invite">
            Invite code for this address
          </label>
          <input
            id="open-invite"
            className={input}
            autoComplete="off"
            spellCheck={false}
            value={invite}
            onChange={(event) => setInvite(event.target.value.trim())}
          />
        </div>
      )}
      {(needsInvite || notice?.tone === "wait") && status !== "open" && (
        <button
          type="button"
          className={`${btnPrimary} h-10 w-full`}
          disabled={opening || (needsInvite && invite.length === 0)}
          onClick={() => onOpen(invite.length > 0 ? invite : undefined)}
        >
          {opening ? "Opening…" : "Open account"}
        </button>
      )}
      {notice && (
        <p
          role={notice.tone === "error" ? "alert" : "status"}
          className={`${TONE_CLASS[notice.tone]} text-[12px]`}
        >
          {notice.text}
        </p>
      )}

      {keyStep?.kind === "settling" && (
        <p role="status" className="text-dim text-[12px]">
          Setting up trading on this device. Ready in about {keyStep.secondsLeft}s.
        </p>
      )}
      {keyStep?.kind === "installing" && (
        <p role="status" className="text-dim text-[12px]">
          Setting up trading on this device. Approve the request in your wallet.
        </p>
      )}
      {keyStep?.kind === "failed" && (
        <p role="alert" className="text-danger text-[12px]">
          {keyStep.reason} Trading stays off until the keys are set up.
        </p>
      )}
      {offer && (
        <button
          type="button"
          className={`${btnGhost} h-9 w-full`}
          disabled={checking}
          onClick={() => {
            setChecking(true);
            void onRecheck().finally(() => setChecking(false));
          }}
        >
          {checking ? "Checking…" : offer === "retry" ? "Retry" : "Check again"}
        </button>
      )}
      {status === "unknown" && keyStep?.kind !== "failed" && (
        <p role="status" className="text-warning text-[12px]">
          Your account could not be read, so trading is off. Check again.
        </p>
      )}
      {keysMayNotPersist(keys) && (
        <p role="alert" className="text-warning text-[12px]">
          This browser may not keep your trading keys (a private window or blocked storage). Trading
          from it is not recommended.
        </p>
      )}
    </div>
  );
}
