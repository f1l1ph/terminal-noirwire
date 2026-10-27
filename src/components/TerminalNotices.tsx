"use client";

import { useDepositInProgress } from "@/components/hooks/useDepositInProgress";

export const PRICES_DOWN_NOTICE = "Prices are not loading. Your funds are safe; we keep retrying.";
export const DEPOSIT_IN_PROGRESS_NOTICE =
  "Deposit in progress: keep this browser open until it finishes";

/**
 * Lines that stay on screen while they are true, above the workspace: the
 * price service cannot be reached, or a deposit is between its first step
 * and its last and only this browser can finish it.
 */
export function TerminalNotices({
  owner,
  pricesUnreachable,
}: {
  owner: string | null;
  pricesUnreachable: boolean;
}) {
  const depositOpen = useDepositInProgress(owner);
  if (!pricesUnreachable && !depositOpen) return null;
  return (
    <div className="flex shrink-0 flex-col gap-1 px-3 sm:px-4">
      {pricesUnreachable && (
        <p
          role="status"
          className="border-line text-warning rounded-tile border px-3 py-1.5 text-[12px]"
        >
          {PRICES_DOWN_NOTICE}
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
