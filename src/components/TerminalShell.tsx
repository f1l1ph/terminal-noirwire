import type { ReactNode } from "react";
import { Mark } from "@/components/ui/Mark";
import { NetworkBadge } from "@/components/ui/NetworkBadge";
import { ConnectionStatus } from "@/components/ConnectionStatus";
import { WalletWidget } from "@/components/WalletWidget";
import type { ConnectionState } from "@/lib/market-data/socket";
import type { WalletHookResult } from "@/lib/wallet/useWallet";

/**
 * The fixed 1440 x 900 frame from the design review: `h-dvh`, no document
 * scroll. Header and status bar span the full width at a fixed height;
 * everything between them is one flexible column so it still holds at a
 * shorter or taller viewport, with only the panels meant to scroll
 * actually scrolling.
 */
export function TerminalShell({
  connectionState,
  wallet,
  statusBarText,
  children,
}: {
  connectionState: ConnectionState;
  wallet: WalletHookResult;
  statusBarText: string;
  children: ReactNode;
}) {
  return (
    <div className="bg-base flex h-dvh min-h-0 flex-col overflow-hidden">
      <header className="border-line-subtle flex h-12 shrink-0 items-center justify-between gap-4 border-b px-4">
        <div className="flex items-center gap-2">
          <Mark size={18} title="NoirWire" />
          <span className="text-ink-strong text-[13px] font-semibold tracking-tight">NoirWire</span>
          <NetworkBadge />
        </div>
        <div className="flex items-center gap-3">
          <ConnectionStatus state={connectionState} />
          <WalletWidget wallet={wallet} />
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden px-4 py-2">
        {children}
      </main>
      <footer className="border-line-subtle text-faint tnum flex h-9 shrink-0 items-center border-t px-4 text-[11px]">
        {statusBarText}
      </footer>
    </div>
  );
}
