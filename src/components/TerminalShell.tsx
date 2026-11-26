import type { ReactNode } from "react";
import { Mark } from "@/components/ui/Mark";
import { NetworkBadge } from "@/components/ui/NetworkBadge";
import { ConnectionStatus } from "@/components/ConnectionStatus";
import { WalletWidget } from "@/components/WalletWidget";
import { FunModeToggle } from "@/components/FunModeToggle";
import { FunFuse } from "@/components/FunFuse";
import { panelColumnGround } from "@/components/ui/styles";
import { FunThread } from "@/components/FunThread";
import { TripwireProvider } from "@/components/TripwireContext";
import {
  FunWizard,
  HIDE_FROM_SPOT_WIDTH,
  WizardSpot,
  type WizardSpotData,
} from "@/components/FunWizard";
import type { TintStyle } from "@/lib/layout/funMode";
import type { Mood } from "@/lib/trading/positionMood";
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
  settings,
  notices,
  tintMood,
  tintStyle,
  wizard,
  wizardInHeader,
  children,
}: {
  /** The mood the screen is tinted with; null leaves it untinted. */
  tintMood: Mood | null;
  tintStyle: TintStyle;
  wizard: WizardSpotData | null;
  /** The compact wizard sits in the header on a desktop layout (until the market card has room for his spot) and in a fixed row under it on a phone. */
  wizardInHeader: boolean;
  connectionState: ConnectionState;
  wallet: WalletHookResult;
  /** The quiet line under the workspace; absent where it would add nothing. */
  footer: ReactNode;
  /** The settings cog, last in the header's right cluster. */
  settings?: ReactNode;
  /** Lines that stay above the workspace while they are true. */
  notices?: ReactNode;
  children: ReactNode;
}) {
  return (
    <TripwireProvider mood={tintStyle === "tripwire" ? tintMood : null}>
      <div className="bg-base isolate flex h-dvh min-h-0 flex-col overflow-hidden">
        {tintMood && tintStyle === "fuse" && <FunFuse mood={tintMood} />}
        {tintMood && tintStyle === "tripwire" && <FunThread mood={tintMood} />}
        <header
          className={`${panelColumnGround} relative z-[110] flex h-12 shrink-0 items-center justify-between gap-2 px-3 whitespace-nowrap sm:gap-4 sm:px-4`}
        >
          <div className="flex min-w-0 items-center gap-2">
            <Mark size={18} title="NoirWire" />
            <span className="text-ink-strong text-[13px] font-semibold tracking-tight max-sm:sr-only">
              NoirWire
            </span>
            <NetworkBadge />
          </div>
          {wizard && wizardInHeader && (
            <FunWizard
              mood={wizard.mood}
              speech={wizard.speech}
              className={`min-w-0 flex-1 ${HIDE_FROM_SPOT_WIDTH}`}
            />
          )}
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <FunModeToggle />
            <ConnectionStatus state={connectionState} />
            <WalletWidget wallet={wallet} />
            {settings}
          </div>
        </header>
        {wizard && !wizardInHeader && (
          <WizardSpot
            data={wizard}
            variant="phone"
            className={`${panelColumnGround} relative h-14 shrink-0 px-3 sm:px-4`}
          />
        )}
        {notices}
        <main className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden px-3 pb-2 sm:px-4">
          {children}
        </main>
        {footer && (
          <footer className="text-faint tnum relative flex h-9 shrink-0 items-center justify-between gap-3 px-3 text-[11px] sm:px-4">
            {footer}
          </footer>
        )}
      </div>
    </TripwireProvider>
  );
}
