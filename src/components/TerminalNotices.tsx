"use client";

import { useDepositInProgress } from "@/components/hooks/useDepositInProgress";
import { useKeySweepInProgress } from "@/components/hooks/useKeySweepInProgress";
import { shortSignature } from "@/lib/transfer/attention";

export const PRICES_DOWN_NOTICE = "Prices are not loading. Your funds are safe; we keep retrying.";
export const PRICES_DOWN_KEPT_SETTINGS_NOTICE =
  "Price service unreachable. Using the last market settings this browser saw, so you can see positions, cancel orders, withdraw, and close once a price arrives. New positions wait until it is back. Retrying.";
export const DEPOSIT_IN_PROGRESS_NOTICE =
  "Deposit in progress: keep this browser open until it finishes";
export const KEY_SWEEP_NOTICE =
  "Your spare SOL is on its way back to your wallet. This takes a few seconds.";
export const SESSION_REFUSED_NOTICE =
  "The exchange stopped accepting your sign-in, so balances and orders have stopped updating. Your funds are safe. Sign in again to continue.";
export const TRADING_IN_OTHER_TAB_NOTICE =
  "Trading is open in another tab on this account. You can still look around here, but orders and cancels are off so the two tabs do not clash.";

function copySignature(signature: string) {
  try {
    void navigator.clipboard.writeText(signature).catch(() => {});
  } catch {
    // No clipboard here: the shortened signature on screen is all there is.
  }
}

/**
 * Lines that stay on screen while they are true, above the workspace: the
 * price service cannot be reached, a deposit is between its first step and
 * its last and only this browser can finish it, or the deposit key is
 * returning its spare SOL to the wallet.
 */
export function TerminalNotices({
  owner,
  pricesUnreachable,
  usingKeptSettings,
  tradingElsewhere,
  onUseThisTab,
  sessionStopped = false,
  onSignInAgain = () => {},
}: {
  owner: string | null;
  pricesUnreachable: boolean;
  usingKeptSettings: boolean;
  tradingElsewhere: boolean;
  onUseThisTab: () => void;
  /** The exchange refused a freshly signed token; nothing signs in on its own until the owner does. */
  sessionStopped?: boolean;
  onSignInAgain?: () => void;
}) {
  const depositOpen = useDepositInProgress(owner);
  const sweep = useKeySweepInProgress(owner);
  if (!pricesUnreachable && !depositOpen && !sweep && !tradingElsewhere && !sessionStopped) {
    return null;
  }
  return (
    <div className="flex shrink-0 flex-col gap-1 px-3 sm:px-4">
      {sessionStopped && (
        <p
          role="alert"
          className="border-line text-warning rounded-tile flex flex-wrap items-center gap-2 border px-3 py-1.5 text-[12px]"
        >
          <span>{SESSION_REFUSED_NOTICE}</span>
          <button type="button" onClick={onSignInAgain} className="text-ink underline">
            Sign in again
          </button>
        </p>
      )}
      {tradingElsewhere && (
        <p
          role="status"
          className="border-line text-warning rounded-tile flex flex-wrap items-center gap-2 border px-3 py-1.5 text-[12px]"
        >
          <span>{TRADING_IN_OTHER_TAB_NOTICE}</span>
          <button type="button" onClick={onUseThisTab} className="text-ink underline">
            Use this tab
          </button>
        </p>
      )}
      {pricesUnreachable && (
        <p
          role="status"
          className="border-line text-warning rounded-tile border px-3 py-1.5 text-[12px]"
        >
          {usingKeptSettings ? PRICES_DOWN_KEPT_SETTINGS_NOTICE : PRICES_DOWN_NOTICE}
        </p>
      )}
      {depositOpen && (
        <p
          role="status"
          className="border-line text-warning rounded-tile border px-3 py-1.5 text-[12px]"
        >
          {DEPOSIT_IN_PROGRESS_NOTICE}
        </p>
      )}
      {sweep && (
        <p
          role="status"
          className="border-line text-dim rounded-tile flex flex-wrap items-center gap-2 border px-3 py-1.5 text-[12px]"
        >
          <span>{KEY_SWEEP_NOTICE}</span>
          {sweep.signature && (
            <>
              <span className="tnum text-faint" title={sweep.signature}>
                {shortSignature(sweep.signature)}
              </span>
              <button
                type="button"
                onClick={() => copySignature(sweep.signature ?? "")}
                className="text-ink underline"
              >
                Copy signature
              </button>
            </>
          )}
        </p>
      )}
    </div>
  );
}
