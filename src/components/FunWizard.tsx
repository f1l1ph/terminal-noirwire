"use client";

import type { Mood, MoodState } from "@/lib/trading/positionMood";
import { moodFact, type Speech } from "@/components/wizardSpeech";

const EYE_LEFT = 17.5;
const EYE_RIGHT = 30.5;
const EYE_Y = 36;
const EYE_FILL = "var(--color-base)";

function Pill({ x, y, height = 6.4 }: { x: number; y: number; height?: number }) {
  return <rect x={x - 1.5} y={y - height / 2} width="3" height={height} rx="1.5" fill={EYE_FILL} />;
}

function Eyes({ state }: { state: MoodState }) {
  const stroke = { stroke: EYE_FILL, strokeWidth: 1.9, strokeLinecap: "round" as const };
  switch (state) {
    case "nearProfit":
      return (
        <g>
          <Pill x={EYE_LEFT} y={EYE_Y - 2.2} />
          <Pill x={EYE_RIGHT} y={EYE_Y - 2.2} />
        </g>
      );
    case "atProfit":
      return (
        <g fill="none" {...stroke}>
          <path d={`M${EYE_LEFT - 2.8} ${EYE_Y + 1.4}q2.8-5 5.6 0`} />
          <path d={`M${EYE_RIGHT - 2.8} ${EYE_Y + 1.4}q2.8-5 5.6 0`} />
        </g>
      );
    case "nearDanger":
      return (
        <g>
          <Pill x={EYE_LEFT + 2.4} y={EYE_Y} height={5.4} />
          <Pill x={EYE_RIGHT + 2.4} y={EYE_Y} height={5.4} />
        </g>
      );
    case "atDanger":
      return (
        <g fill="none" {...stroke} strokeWidth={1.7}>
          <path d={`M${EYE_LEFT - 2.4} ${EYE_Y - 2.6}l4.8 5.2m0-5.2l-4.8 5.2`} />
          <path d={`M${EYE_RIGHT - 2.4} ${EYE_Y - 2.6}l4.8 5.2m0-5.2l-4.8 5.2`} />
        </g>
      );
    case "unknown":
      return (
        <g fill="none" {...stroke} strokeWidth={1.6}>
          <path d={`M${EYE_LEFT - 2.6} ${EYE_Y}h5.2`} />
          <path d={`M${EYE_RIGHT - 2.6} ${EYE_Y}h5.2`} />
        </g>
      );
    case "calm":
      return (
        <g>
          <Pill x={EYE_LEFT} y={EYE_Y} />
          <Pill x={EYE_RIGHT} y={EYE_Y} />
        </g>
      );
  }
}

const SPARKLE_PATH = "M0-3C.4-1 1-.4 3 0C1 .4 .4 1 0 3C-.4 1-1 .4-3 0C-1-.4-.4-1 0-3z";

function Sparkle({
  x,
  y,
  scale,
  color,
  delay = 0,
}: {
  x: number;
  y: number;
  scale: number;
  color: string;
  delay?: number;
}) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <path
        className="fun-sparkle"
        style={{ animationDelay: `${delay}s` }}
        d={SPARKLE_PATH}
        fill={color}
      />
    </g>
  );
}

const HAT_POSE: Record<MoodState, string> = {
  calm: "",
  unknown: "rotate(6 23 24) translate(0 1.5)",
  nearProfit: "rotate(-3 23 24)",
  atProfit: "rotate(-11 23 24) translate(-1 -1)",
  nearDanger: "rotate(5 23 24)",
  atDanger: "rotate(17 23 24) translate(3 2.5)",
};

function Extras({ state }: { state: MoodState }) {
  const safe = "var(--color-safe)";
  const danger = "var(--color-danger)";
  switch (state) {
    case "nearProfit":
      return <Sparkle x={7} y={4} scale={1.9} color={safe} />;
    case "atProfit":
      return (
        <g>
          <Sparkle x={4.5} y={8} scale={2.4} color={safe} />
          <Sparkle x={42} y={14} scale={2.1} color={safe} delay={0.5} />
          <Sparkle x={43} y={30} scale={1.5} color={safe} delay={1} />
        </g>
      );
    case "nearDanger":
      return <path d="M42 24.5q-3 4.2-3 6.2a3 3 0 0 0 6 0q0-2-3-6.2z" fill={danger} />;
    case "atDanger":
      return (
        <g>
          <path d="M43 24q-2.6 3.8-2.6 5.6a2.6 2.6 0 0 0 5.2 0q0-1.8-2.6-5.6z" fill={danger} />
          <path
            d="M4.5 30l-2.5 3M3.5 36.5l-2.5.5"
            stroke={danger}
            strokeWidth="1.5"
            strokeLinecap="round"
            fill="none"
          />
        </g>
      );
    case "unknown":
      return (
        <g fill="var(--color-faint)" fontWeight="700">
          <text x="38" y="17" fontSize="9">
            z
          </text>
          <text x="43" y="9" fontSize="6.5">
            z
          </text>
        </g>
      );
    case "calm":
      return null;
  }
}

const GLOW: Partial<Record<MoodState, string>> = {
  nearProfit: "var(--color-safe)",
  atProfit: "var(--color-safe)",
  nearDanger: "var(--color-danger)",
  atDanger: "var(--color-danger)",
};

/**
 * The cube wizard: a white cube seen corner-on under a pointed hat. Only the
 * eyes, hat angle and small extras change with the mood; the mood colour is a
 * soft glow behind it, never a recolour of the character.
 */
export function WizardFigure({
  state,
  size,
  className,
}: {
  state: MoodState;
  /** Rendered height and width in px. */
  size: number;
  className?: string;
}) {
  const glow = GLOW[state];
  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex shrink-0 ${className ?? ""}`}
      style={{ width: size, height: size }}
      data-pose={state}
    >
      {glow && (
        <span
          className="absolute inset-[12%] rounded-full opacity-45 blur-[6px]"
          style={{ background: glow }}
        />
      )}
      <svg
        viewBox="0 0 48 48"
        width={size}
        height={size}
        className={`relative ${state === "atDanger" ? "fun-shake" : ""}`}
      >
        <g fill="var(--color-ink-strong)" stroke="var(--color-ink-strong)" strokeLinejoin="round">
          <polygon points="10,26 38,26 38,37 24,44.5 10,37" strokeWidth="4" />
        </g>
        <polygon points="24,32 38,26 38,37 24,44.5" fill="var(--color-base)" opacity="0.1" />
        <g transform={HAT_POSE[state]}>
          <ellipse
            cx="23"
            cy="25.2"
            rx="20.4"
            ry="4.6"
            transform="rotate(-9 23 25.2)"
            fill="var(--color-base)"
          />
          <g fill="var(--color-ink-strong)" stroke="var(--color-ink-strong)" strokeLinejoin="round">
            <ellipse
              cx="23"
              cy="23.5"
              rx="20"
              ry="4.3"
              transform="rotate(-9 23 23.5)"
              strokeWidth="0"
            />
            <path d="M12 24.5L33 20.5L8 4z" strokeWidth="2" />
          </g>
        </g>
        <Eyes state={state} />
        <Extras state={state} />
      </svg>
    </span>
  );
}

/**
 * The header wizard and its one speech line. The line comes from the shared
 * speech so the pop-out shows the same words, and the text carries the same
 * fact as the colour.
 */
export function FunWizard({
  mood,
  speech,
  className,
}: {
  mood: Mood;
  speech: Speech;
  className?: string;
}) {
  const fact = moodFact(mood);
  return (
    <div
      data-testid="fun-wizard"
      className={`flex min-w-0 items-center gap-2 overflow-hidden ${className ?? ""}`}
    >
      <WizardFigure state={mood.state} size={34} />
      <p role="status" aria-live="polite" className="text-dim min-w-0 truncate text-[12px]">
        {fact && (
          <span className="border-line text-ink mr-2 inline-block rounded-full border px-2 py-px text-[11px]">
            {fact}
          </span>
        )}
        {speech.line}
      </p>
    </div>
  );
}
