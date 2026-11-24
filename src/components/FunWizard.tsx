"use client";

import { useState } from "react";
import type { Mood, MoodState } from "@/lib/trading/positionMood";

export const WIZARD_LINES: Record<MoodState, readonly string[]> = {
  calm: [
    "Wizard is off shift.",
    "Sir, this is a terminal.",
    "Probably nothing.",
    "Charts, but make it cozy.",
  ],
  nearProfit: ["WAGMI? The wand is hopeful.", "Number go up energy.", "Few understand this setup."],
  atProfit: ["We're so back.", "Mark met your take profit price.", "Tiny wizard, big grin."],
  nearDanger: [
    "The hat looks concerned.",
    "NGMI? Too early to call.",
    "Wizard is watching the margin.",
  ],
  atDanger: [
    "It's so over. Check the numbers.",
    "This is fine. Check your margin.",
    "Sir, this is a casino. Read the risk.",
  ],
  unknown: ["Wizard is napping.", "Nap time. Numbers first."],
};

/** The plain-text fact behind the mood, so colour and a drawing are never the only signal. */
export function moodFact(mood: Mood): string | null {
  switch (mood.state) {
    case "nearDanger":
      return mood.reason === "liquidation" ? "Near estimated liquidation" : "Near stop loss";
    case "atDanger":
      return mood.reason === "liquidation" ? "At estimated liquidation" : "Mark at stop loss";
    case "nearProfit":
      return "Near take profit";
    case "atProfit":
      return "Mark at take profit";
    case "unknown":
      return mood.reason === "accountUnreadable" ? "Account risk not readable" : "No fresh price";
    case "calm":
      return null;
  }
}

/** The line for the nth time this state is entered; a counter, so there is nothing random to test. */
export function pickLine(state: MoodState, entered: number): string {
  const lines = WIZARD_LINES[state];
  return lines[entered % lines.length]!;
}

function Eyes({ state }: { state: MoodState }) {
  if (state === "unknown") {
    return (
      <g stroke="var(--color-base)" strokeWidth="1" strokeLinecap="round">
        <path d="M13 17.2h2" />
        <path d="M17.5 17.2h2" />
      </g>
    );
  }
  if (state === "nearProfit" || state === "atProfit") {
    return (
      <g>
        <circle cx="14" cy="17" r="1.5" fill="var(--color-base)" />
        <circle cx="18" cy="17" r="1.5" fill="var(--color-base)" />
        <circle cx="14.5" cy="16.5" r="0.5" fill="var(--color-ink-strong)" />
        <circle cx="18.5" cy="16.5" r="0.5" fill="var(--color-ink-strong)" />
      </g>
    );
  }
  return (
    <g fill="var(--color-base)">
      <circle cx="14" cy="17" r="0.9" />
      <circle cx="18" cy="17" r="0.9" />
    </g>
  );
}

function Mouth({ state }: { state: MoodState }) {
  const stroke = { stroke: "var(--color-base)", strokeWidth: 0.8, strokeLinecap: "round" as const };
  if (state === "atProfit") return <path d="M14 19.3q2 2 4 0" fill="none" {...stroke} />;
  if (state === "nearProfit") return <path d="M14.5 19.6q1.5 1 3 0" fill="none" {...stroke} />;
  if (state === "nearDanger" || state === "atDanger") {
    return <path d="M14.5 20.2q1.5-1.1 3 0" fill="none" {...stroke} />;
  }
  return <path d="M14.7 19.8h2.6" fill="none" {...stroke} />;
}

function Pose({ state }: { state: MoodState }) {
  const arm = {
    stroke: "var(--color-dim)",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    fill: "none",
  };
  const wand = {
    stroke: "var(--color-faint)",
    strokeWidth: 1.2,
    strokeLinecap: "round" as const,
  };
  switch (state) {
    case "nearProfit":
      return (
        <g>
          <path d="M21 25l4.5-9.5" {...arm} />
          <path d="M25.5 15.5l1.5-3.5" {...wand} />
          <circle cx="27.2" cy="11.6" r="1" fill="var(--color-warning)" />
        </g>
      );
    case "atProfit":
      return (
        <g>
          <path d="M21 25l5-10" {...arm} />
          <path d="M11 25l-4-8" {...arm} />
          <path d="M26 15l1.2-3" {...wand} />
          <circle cx="27.4" cy="11.4" r="1.2" fill="var(--color-warning)" />
          <circle className="fun-sparkle" cx="29.5" cy="8" r="0.9" fill="var(--color-warning)" />
          <circle
            className="fun-sparkle"
            style={{ animationDelay: "0.5s" }}
            cx="24.5"
            cy="8.5"
            r="0.8"
            fill="var(--color-safe)"
          />
          <circle
            className="fun-sparkle"
            style={{ animationDelay: "1s" }}
            cx="30"
            cy="13.5"
            r="0.7"
            fill="var(--color-safe)"
          />
        </g>
      );
    case "atDanger":
      return (
        <g>
          <path d="M11 26l1.5-6.5q.5-1.5 1.5-1.8" {...arm} />
          <circle cx="13.8" cy="17.4" r="1.9" fill="var(--color-dim)" />
          <path d="M21 25l3 3" {...arm} />
          <path
            d="M24.2 12.5q-1.4 2-1.4 3a1.4 1.4 0 0 0 2.8 0q0-1-1.4-3z"
            fill="var(--color-safe)"
            opacity="0.85"
          />
        </g>
      );
    case "nearDanger":
      return (
        <g>
          <path d="M21 25l3.5 3.5" {...arm} />
          <path d="M24.5 28.5l1.5 1.5" {...wand} />
          <path
            d="M12.3 14.8l2.4.9M19.7 14.8l-2.4.9"
            stroke="var(--color-base)"
            strokeWidth="0.8"
            strokeLinecap="round"
          />
        </g>
      );
    case "unknown":
      return (
        <g>
          <path d="M21 25l3.5 3.5" {...arm} />
          <path d="M24.5 28.5l1.5 1.5" {...wand} />
          <text x="22" y="10" fontSize="6" fill="var(--color-faint)" fontWeight="600">
            z
          </text>
          <text x="26.5" y="6" fontSize="4.5" fill="var(--color-faint)" fontWeight="600">
            z
          </text>
        </g>
      );
    case "calm":
      return (
        <g>
          <path d="M21 25l3.5 3.5" {...arm} />
          <path d="M24.5 28.5l1.5 1.5" {...wand} />
        </g>
      );
  }
}

function Wizard({ state }: { state: MoodState }) {
  const tilt = state === "atDanger" ? -16 : state === "nearDanger" ? -10 : 0;
  return (
    <svg
      aria-hidden="true"
      width="30"
      height="30"
      viewBox="0 0 32 32"
      className="shrink-0"
      data-pose={state}
    >
      <path
        d="M9 31l2-9q5-3 10 0l2 9z"
        fill="var(--color-elevated)"
        stroke="var(--color-line-strong)"
        strokeWidth="0.8"
      />
      <circle cx="16" cy="17.5" r="4.6" fill="var(--color-dim)" />
      <g transform={`rotate(${tilt} 16 13)`}>
        <path
          d="M16 1.5L8.5 13.5h15z"
          fill="var(--color-elevated)"
          stroke="var(--color-line-strong)"
          strokeWidth="0.8"
          strokeLinejoin="round"
        />
        <path
          d="M6.5 13.5h19"
          stroke="var(--color-line-strong)"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
        <path
          d="M16 6.2l.9 1.9 2 .2-1.5 1.3.5 2-1.9-1-1.9 1 .5-2-1.5-1.3 2-.2z"
          fill="var(--color-warning)"
        />
      </g>
      <Eyes state={state} />
      <Mouth state={state} />
      <Pose state={state} />
    </svg>
  );
}

/**
 * A small wizard and one speech line that react to the mood with meme
 * flavour. Only the pose changes; the line is picked when a state is entered,
 * never on a tick, and the text carries the same fact as the colour.
 */
export function FunWizard({ mood, className }: { mood: Mood; className?: string }) {
  const [spoken, setSpoken] = useState({ state: mood.state, reason: mood.reason, entered: 0 });
  if (spoken.state !== mood.state) {
    setSpoken({ state: mood.state, reason: mood.reason, entered: spoken.entered + 1 });
  } else if (spoken.reason !== mood.reason) {
    setSpoken({ ...spoken, reason: mood.reason });
  }
  const fact = moodFact({ ...mood, state: spoken.state, reason: spoken.reason });
  const line = pickLine(spoken.state, spoken.entered);
  return (
    <div
      data-testid="fun-wizard"
      className={`flex min-w-0 items-center gap-2 overflow-hidden ${className ?? ""}`}
    >
      <Wizard state={mood.state} />
      <p role="status" aria-live="polite" className="text-dim min-w-0 truncate text-[12px]">
        {fact && (
          <span className="border-line text-ink mr-2 inline-block rounded-full border px-2 py-px text-[11px]">
            {fact}
          </span>
        )}
        {line}
      </p>
    </div>
  );
}
