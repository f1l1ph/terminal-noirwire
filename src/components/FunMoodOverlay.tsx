import type { Mood } from "@/lib/trading/positionMood";

const VIGNETTE_ALPHA_PERCENT = 35;
const EDGE_LINE_ALPHA_PERCENT = 55;
const EDGE_GLOW_ALPHA_PERCENT = 32;
const WASH_ALPHA_PERCENT = 6;

function tone(color: string, percent: number): string {
  return `color-mix(in oklab, ${color} ${percent}%, transparent)`;
}

/**
 * A coloured edge, not a flat fill, so prices in the middle of the screen
 * stay readable: red as an open position nears its estimated liquidation or
 * stop loss, green as it nears its take profit. A vignette and a thin glow
 * along the screen edge carry it; a faint even wash joins only once a target
 * is reached. It never takes a click.
 */
export function FunMoodOverlay({ mood }: { mood: Mood }) {
  const danger = mood.state === "nearDanger" || mood.state === "atDanger";
  const profit = mood.state === "nearProfit" || mood.state === "atProfit";
  if (!danger && !profit) return null;
  const color = danger ? "var(--color-danger)" : "var(--color-safe)";
  const breathing = mood.state === "atDanger" && mood.intensity === 1;
  const reached = mood.state === "atDanger" || mood.state === "atProfit";
  const vignette = `radial-gradient(ellipse closest-side at 50% 50%, transparent 62%, ${tone(color, VIGNETTE_ALPHA_PERCENT)} 100%)`;
  const wash = tone(color, reached ? WASH_ALPHA_PERCENT : 0);
  return (
    <div
      aria-hidden="true"
      data-testid="fun-mood-overlay"
      data-mood={mood.state}
      className={`pointer-events-none fixed inset-0 z-[100] transition-opacity duration-250 ${breathing ? "fun-breathe" : ""}`}
      style={{
        opacity: mood.intensity,
        background: `${vignette}, linear-gradient(${wash}, ${wash})`,
        boxShadow: `inset 0 0 0 2px ${tone(color, EDGE_LINE_ALPHA_PERCENT)}, inset 0 0 56px 4px ${tone(color, EDGE_GLOW_ALPHA_PERCENT)}`,
      }}
    />
  );
}
