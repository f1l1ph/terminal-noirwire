import type { ReactNode } from "react";
import { Mark } from "@/components/ui/Mark";
import { NetworkBadge } from "@/components/ui/NetworkBadge";
import { ConnectionStatus } from "@/components/ConnectionStatus";
import { WalletWidget } from "@/components/WalletWidget";
import type { ConnectionState } from "@/lib/market-data/socket";
import type { WalletHookResult } from "@/lib/wallet/useWallet";

/**
 * The fixed 1440 x 900 frame from the design review: `h-dvh`, no document
 * scroll. Header and footer span the full width at a fixed height;
 * everything between them is one flexible column so it still holds at a
 * shorter or taller viewport, with only the panels meant to scroll
 * actually scrolling. The header never wraps: wordmark, network badge and
 * wallet button stay on one line at 390 px.
 */
export function TerminalShell({
  connectionState,
  wallet,
  footer,
  onResetLayout,
  notices,
  children,
}: {
  connectionState: ConnectionState;
  wallet: WalletHookResult;
  /** The quiet line under the workspace; absent where it would add nothing. */
  footer: ReactNode;
  /** Present only once the desktop workspace layout differs from its default - the control itself appears only then. */
  onResetLayout?: () => void;
  /** Lines that stay above the workspace while they are true. */
  notices?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="bg-base flex h-dvh min-h-0 flex-col overflow-hidden">
      <header className="relative z-20 flex h-12 shrink-0 items-center justify-between gap-2 px-3 whitespace-nowrap sm:gap-4 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Mark size={18} title="NoirWire" />
          <span className="text-ink-strong text-[13px] font-semibold tracking-tight">NoirWire</span>
          <NetworkBadge />
        </div>
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          {onResetLayout && (
            <button
              type="button"
              className="text-dim hover:text-ink rounded-tile text-[12px] underline decoration-dotted underline-offset-2"
              onClick={onResetLayout}
            >
              Reset layout
            </button>
          )}
          <ConnectionStatus state={connectionState} />
          <WalletWidget wallet={wallet} />
        </div>
      </header>
      {notices}
      <main className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden px-3 pb-2 sm:px-4">
        {children}
      </main>
      {footer && (
        <footer className="text-faint tnum flex h-9 shrink-0 items-center justify-between gap-3 px-3 text-[11px] sm:px-4">
          {footer}
        </footer>
      )}
    </div>
  );
}
