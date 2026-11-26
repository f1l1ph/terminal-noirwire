"use client";

import { tripwireColor, threadOpacity } from "@/lib/trading/tripwire";
import type { Mood } from "@/lib/trading/positionMood";

/** A 2px line along the very top of the screen that grows from the left as the price nears its target. */
export function FunThread({ mood }: { mood: Mood }) {
  if (mood.tone === null) return null;
  return (
    <div
      aria-hidden="true"
      data-testid="fun-thread"
      data-tone={mood.tone}
      className="fun-thread pointer-events-none fixed top-0 left-0 z-[130] h-0.5 w-full"
      style={{
        backgroundColor: tripwireColor(mood.tone),
        transform: `scaleX(${mood.progress})`,
        opacity: threadOpacity(mood.intensity),
      }}
    />
  );
}
