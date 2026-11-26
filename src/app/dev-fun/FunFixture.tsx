"use client";

import { ConnectionStatus } from "@/components/ConnectionStatus";
import { FunModeToggle } from "@/components/FunModeToggle";
import { FunFuse } from "@/components/FunFuse";
import { FunThread } from "@/components/FunThread";
import { TripwireProvider } from "@/components/TripwireContext";
import { TripwireScene } from "./TripwireScene";
import { FunWizard, HIDE_FROM_SPOT_WIDTH, WizardSpot } from "@/components/FunWizard";
import { useWizardSpeech } from "@/components/hooks/useWizardSpeech";
import { useMediaQuery } from "@/components/hooks/useMediaQuery";
import { BarStat, MarketBarFrame } from "@/components/MarketContextBar";
import { SettingsMenu } from "@/components/SettingsMenu";
import { Mark } from "@/components/ui/Mark";
import { NetworkBadge } from "@/components/ui/NetworkBadge";
import { formatShortAddress } from "@/lib/format";
import type { TintStyle } from "@/lib/layout/funMode";
import type { Gauge, Mood } from "@/lib/trading/positionMood";

/** The Fun mode header controls, tint and wizard over plain panels, for one chosen mood. */
export function FunFixture({
  mood,
  gauge,
  wallet,
  tintStyle,
  scene,
}: {
  mood: Mood;
  tintStyle: TintStyle;
  /** The chart and position the Tripwire reads; null keeps the plain panels. */
  scene: { entry: number; mark: number } | null;
  /** The risk range the bar draws; none leaves the line alone. */
  gauge: Gauge | null;
  /** The wallet button's width as the real one has it: plain, with "Locked", or with "Not saved". */
  wallet: "plain" | "locked" | "unsaved";
}) {
  const wide = useMediaQuery("(min-width: 900px)");
  const speech = useWizardSpeech(mood);
  const wizard = { mood, speech, gauge };
  return (
    <TripwireProvider mood={tintStyle === "tripwire" ? mood : null}>
      <div className="bg-base isolate flex h-dvh min-h-0 flex-col overflow-hidden">
        {tintStyle === "fuse" && <FunFuse mood={mood} />}
        {tintStyle === "tripwire" && <FunThread mood={mood} />}
        <header className="bg-base relative z-[110] flex h-12 shrink-0 items-center justify-between gap-2 px-3 whitespace-nowrap sm:gap-4 sm:px-4">
          <div className="flex min-w-0 items-center gap-2">
            <Mark size={18} title="NoirWire" />
            <span className="text-ink-strong text-[13px] font-semibold tracking-tight max-sm:sr-only">
              NoirWire
            </span>
            <NetworkBadge />
          </div>
          {wide && (
            <FunWizard
              mood={mood}
              speech={speech}
              className={`min-w-0 flex-1 ${HIDE_FROM_SPOT_WIDTH}`}
            />
          )}
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <FunModeToggle />
            <ConnectionStatus state="open" />
            <span className="border-line text-ink rounded-tile flex min-h-11 items-center border px-3 text-[13px]">
              {formatShortAddress("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU")}
              {wallet === "locked" && <span className="text-faint ml-2 text-[12px]">Locked</span>}
              {wallet === "unsaved" && (
                <span className="text-danger ml-2 text-[12px]">Not saved</span>
              )}
            </span>
            <SettingsMenu keys={null} mainnet />
          </div>
        </header>
        {!wide && (
          <WizardSpot
            data={wizard}
            variant="phone"
            className="bg-base relative h-14 shrink-0 px-3"
          />
        )}
        <main className="flex min-h-0 flex-1 flex-col gap-2 px-3 pb-2 sm:px-4">
          {wide && (
            <MarketBarFrame
              wizard={wizard}
              price={
                <div className="flex flex-col">
                  <span className="tnum text-ink-strong text-[32px] leading-none font-semibold">
                    $150.42
                  </span>
                  <span className="tnum mt-1.5 flex items-baseline gap-x-2">
                    <span className="text-safe text-[14px] font-medium">▲ $1.23 (0.82%)</span>
                    <span className="text-faint text-[11px]">past day</span>
                    <span className="text-faint text-[11px]">3s ago</span>
                  </span>
                </div>
              }
              stats={
                <>
                  <BarStat label="SOL/USD 24h range" value="148.20 - 153.90" />
                  <BarStat label="Max leverage" value="20x" />
                  <BarStat label="Taker fee" value="0.05%" />
                  <BarStat label="24h volume" value="1,234,567.89 nUSD" />
                  <BarStat label="Open interest" value="12,345.67 SOL" />
                </>
              }
            >
              <span className="text-faint tnum absolute top-3 right-5 text-[11px] underline">
                Market details
              </span>
            </MarketBarFrame>
          )}
          <div className="flex min-h-0 flex-1 gap-2">
            {scene ? (
              <TripwireScene entry={scene.entry} mark={scene.mark} />
            ) : (
              <>
                <section className="bg-surface rounded-panel flex-1 p-4">
                  <p className="text-ink-strong tnum text-[20px]">150.42</p>
                  <p className="text-faint text-[12px]">SOL-PERP mark</p>
                </section>
                <section className="bg-surface rounded-panel hidden w-72 p-4 sm:block">
                  <p className="text-dim text-[12px]">Order entry</p>
                </section>
              </>
            )}
          </div>
        </main>
        <footer className="text-faint tnum relative flex h-9 shrink-0 items-center justify-between gap-3 px-3 text-[11px] sm:px-4">
          <span>SOL-PERP · last data 12:08:16.481</span>
          <span>account synced at 12:08:16.449</span>
        </footer>
      </div>
    </TripwireProvider>
  );
}
