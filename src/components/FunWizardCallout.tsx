"use client";

import { useEffect, useState } from "react";
import { WizardFigure } from "@/components/FunWizard";
import { moodFact, wantsCallout, type Speech } from "@/components/wizardSpeech";

export const CALLOUT_MS = 5000;

/**
 * A big wizard with a speech bubble that pops out for about five seconds when
 * the mood enters a state worth noticing, or Fun mode is switched on. It
 * never takes a click and is hidden from assistive tech: the header line
 * already announces the same words.
 */
export function FunWizardCallout({ speech }: { speech: Speech }) {
  const [dismissed, setDismissed] = useState<number | null>(null);
  const visible = wantsCallout(speech) && dismissed !== speech.entry;

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => setDismissed(speech.entry), CALLOUT_MS);
    return () => clearTimeout(timer);
  }, [visible, speech.entry]);

  if (!visible) return null;
  const fact = moodFact(speech);
  return (
    <div
      aria-hidden="true"
      data-testid="fun-wizard-callout"
      className="pointer-events-none fixed top-24 left-1/2 z-[105] w-max -translate-x-1/2 sm:top-14 lg:left-[380px] lg:translate-x-0"
    >
      <div key={speech.entry} className="fun-callout flex items-center gap-1">
        <span className="hidden sm:inline-flex">
          <WizardFigure state={speech.state} size={120} />
        </span>
        <span className="inline-flex sm:hidden">
          <WizardFigure state={speech.state} size={96} />
        </span>
        <div className="border-line bg-surface-raised text-ink rounded-panel w-max max-w-[min(18rem,calc(100vw-9rem))] border px-3 py-2 text-[13px] leading-snug shadow-lg">
          {fact && (
            <span className="border-line text-ink mb-1 block w-fit rounded-full border px-2 py-px text-[11px]">
              {fact}
            </span>
          )}
          {speech.line}
        </div>
      </div>
    </div>
  );
}
