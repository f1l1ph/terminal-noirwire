"use client";

import { useDepositInProgress } from "@/components/hooks/useDepositInProgress";

export const PRICES_DOWN_NOTICE = "Prices are not loading. Your funds are safe; we keep retrying.";
export const PRICES_DOWN_KEPT_SETTINGS_NOTICE =
  "Price service unreachable. Using the last market settings this browser saw: you can view, cancel, close and withdraw, but prices may be missing. Retrying.";
export const DEPOSIT_IN_PROGRESS_NOTICE =
  "Deposit in progress: keep this browser open until it finishes";
export const TRADING_IN_OTHER_TAB_NOTICE =
  "Trading is open in another tab on this account. You can still look around here, but orders and cancels are off so the two tabs do not clash.";

/**
 * Lines that stay on screen while they are true, above the workspace: the
 * price service cannot be reached, or a deposit is between its first step
 * and its last and only this browser can finish it.
 */
export function TerminalNotices({
  owner,
  pricesUnreachable,
  usingKeptSettings,
  tradingElsewhere,
  onUseThisTab,
}: {
  owner: string | null;
  pricesUnreachable: boolean;
  usingKeptSettings: boolean;
  tradingElsewhere: boolean;
  onUseThisTab: () => void;
}) {
  const depositOpen = useDepositInProgress(owner);
  if (!pricesUnreachable && !depositOpen && !tradingElsewhere) return null;
  return (
    <div className="flex shrink-0 flex-col gap-1 px-3 sm:px-4">
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
    </div>
  );
}
