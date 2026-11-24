import type { Mood } from "@/lib/trading/positionMood";

const MAX_ALPHA_PERCENT = 22;

/**
 * An edge wash, not a flat fill, so prices in the middle of the screen stay
 * readable: red as an open position nears its estimated liquidation or stop
 * loss, green as it nears its take profit. It never takes a click.
 */
export function FunMoodOverlay({ mood }: { mood: Mood }) {
  const danger = mood.state === "nearDanger" || mood.state === "atDanger";
  const profit = mood.state === "nearProfit" || mood.state === "atProfit";
  if (!danger && !profit) return null;
  const color = danger ? "var(--color-danger)" : "var(--color-safe)";
  const breathing = mood.state === "atDanger" && mood.intensity === 1;
  return (
    <div
      aria-hidden="true"
      data-testid="fun-mood-overlay"
      data-mood={mood.state}
      className={`pointer-events-none fixed inset-0 z-[100] transition-opacity duration-250 ${breathing ? "fun-breathe" : ""}`}
      style={{
        opacity: mood.intensity,
        background: `radial-gradient(ellipse closest-side at 50% 50%, transparent 74%, color-mix(in oklab, ${color} ${MAX_ALPHA_PERCENT}%, transparent) 100%)`,
      }}
    />
  );
}
