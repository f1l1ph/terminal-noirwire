import type { Mood, MoodTarget } from "@/lib/trading/positionMood";

/** Mirror the `--color-fun-danger` and `--color-fun-safe` tokens: a canvas cannot read a CSS variable. */
export const TRIPWIRE_DANGER_COLOR = "#ff3b2e";
export const TRIPWIRE_SAFE_COLOR = "#1fe37a";

const SOLID_FROM_INTENSITY = 0.25;
const MIN_LINE_WIDTH = 1;
const MAX_LINE_WIDTH = 3;
const SHADE_ALPHA = 0.4;

type TripwireTitle = "SL" | "Liq" | "TP";

const TITLES: Record<MoodTarget, TripwireTitle> = {
  stopLoss: "SL",
  liquidation: "Liq",
  takeProfit: "TP",
};

interface TripwireLine {
  price: number;
  color: string;
  lineWidth: 1 | 2 | 3;
  dashed: boolean;
  title: TripwireTitle;
}

export function tripwireColor(tone: "danger" | "profit"): string {
  return tone === "danger" ? TRIPWIRE_DANGER_COLOR : TRIPWIRE_SAFE_COLOR;
}

/** The CSS variable of the Fun colour for a tone, for light and rules drawn in the DOM. */
export function funToneVar(tone: "danger" | "profit"): string {
  return tone === "danger" ? "var(--color-fun-danger)" : "var(--color-fun-safe)";
}

/** The price line to draw at the target on this market's chart, or null when the mood has none for it. */
export function tripwireLine(mood: Mood | null, marketId: string | undefined): TripwireLine | null {
  if (!mood || !mood.tone || !mood.focus || mood.focus.price === null) return null;
  if (marketId === undefined || mood.focus.market !== marketId) return null;
  const price = Number(mood.focus.price);
  if (!Number.isFinite(price)) return null;
  const width = MIN_LINE_WIDTH + (MAX_LINE_WIDTH - MIN_LINE_WIDTH) * mood.intensity;
  return {
    price,
    color: tripwireColor(mood.tone),
    lineWidth: Math.min(MAX_LINE_WIDTH, Math.max(MIN_LINE_WIDTH, Math.round(width))) as 1 | 2 | 3,
    dashed: mood.intensity < SOLID_FROM_INTENSITY,
    title: TITLES[mood.focus.kind],
  };
}

/** The alpha of the runway and the bloom at this intensity. */
export function tripwireShadeAlpha(intensity: number): number {
  return SHADE_ALPHA * Math.min(Math.max(intensity, 0), 1);
}

/** The inset rule on the left of the position card the mood follows; undefined for every other card. */
export function positionCardRule(mood: Mood | null, market: string): string | undefined {
  if (!mood || !mood.tone || !mood.focus || mood.focus.market !== market) return undefined;
  const alpha = Math.round(Math.min(Math.max(mood.intensity, 0), 1) * 100);
  return `inset 2px 0 0 0 color-mix(in oklab, ${funToneVar(mood.tone)} ${alpha}%, transparent)`;
}

/** The top thread's opacity at this intensity. */
export function threadOpacity(intensity: number): number {
  return 0.25 + 0.55 * Math.min(Math.max(intensity, 0), 1);
}
