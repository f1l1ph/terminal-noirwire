"use client";

import { usePrivacyTools } from "@/components/hooks/usePrivacyTools";

/** The one quiet switch that brings the public tape, privacy check, timing and private order log into the workspace. */
export function PrivacyToolsToggle({ className }: { className?: string }) {
  const [on, setOn] = usePrivacyTools();
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => setOn(!on)}
      className={`rounded-tile text-faint hover:text-ink inline-flex min-h-8 items-center gap-2 px-2 text-[12px] whitespace-nowrap transition-colors ${className ?? ""}`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${on ? "bg-ink-strong" : "bg-line-strong"}`}
      />
      Privacy tools
    </button>
  );
}
