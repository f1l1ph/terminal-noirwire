"use client";

import { useFunMode } from "@/components/hooks/useFunMode";

/** The header switch between Normal and Fun, on desktop; phones reach it from Settings. */
export function FunModeToggle() {
  const [settings, update] = useFunMode();
  return (
    <button
      type="button"
      aria-pressed={settings.enabled}
      aria-label="Fun mode"
      onClick={() => update({ enabled: !settings.enabled })}
      className="rounded-tile text-faint hover:text-ink hidden min-h-8 items-center gap-1.5 px-2 text-[12px] whitespace-nowrap transition-colors sm:inline-flex"
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${settings.enabled ? "bg-warning" : "bg-line-strong"}`}
      />
      Fun
    </button>
  );
}
