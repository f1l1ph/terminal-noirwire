import type { ReactNode } from "react";
import { Mark } from "@/components/ui/Mark";
import { NetworkBadge } from "@/components/ui/NetworkBadge";
import { ConnectionStatus } from "@/components/ConnectionStatus";
import { WalletWidget } from "@/components/WalletWidget";
import type { ConnectionState } from "@/lib/market-data/socket";
import type { WalletHookResult } from "@/lib/wallet/useWallet";

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
    <div className="flex min-h-dvh flex-col">
      <header className="border-line-subtle flex items-center justify-between gap-4 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Mark size={20} title="NoirWire" />
          <span className="text-ink-strong text-[14px] font-semibold tracking-tight">
            NoirWire terminal
          </span>
        </div>
        <div className="flex items-center gap-3">
          <NetworkBadge />
          <ConnectionStatus state={connectionState} />
          <WalletWidget wallet={wallet} />
        </div>
      </header>
      <main className="flex-1 px-4 py-4">{children}</main>
      <footer className="border-line-subtle text-faint border-t px-4 py-2 text-[11px]">
        {statusBarText}
      </footer>
    </div>
  );
}
