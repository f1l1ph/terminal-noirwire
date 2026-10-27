import type { Side } from "../sim-api/schema";

export const LIMIT_SLIDER_SPAN = 0.1;

export interface LimitLine {
  price: number;
  side: Side;
}

export interface TickSlider {
  min: number;
  max: number;
}

/** The price the chart should draw for the form's draft, or null when there is nothing valid to draw. */
export function limitLineFor({
  orderType,
  priceText,
  side,
}: {
  orderType: "market" | "limit";
  priceText: string;
  side: Side;
}): LimitLine | null {
  if (orderType !== "limit" || priceText.trim() === "") return null;
  const price = Number(priceText);
  return Number.isFinite(price) && price > 0 ? { price, side } : null;
}

/** The slider runs in whole ticks: plus or minus 10 percent of the mark, so every position is on the grid. */
export function tickSlider(mark: number, tick: number): TickSlider | null {
  if (!(mark > 0) || !(tick > 0)) return null;
  const min = Math.max(1, Math.ceil((mark * (1 - LIMIT_SLIDER_SPAN)) / tick));
  const max = Math.floor((mark * (1 + LIMIT_SLIDER_SPAN)) / tick);
  return max > min ? { min, max } : null;
}

/** Where the slider thumb sits for the typed price: clamped into range, the mark's tick when the price is unusable. */
export function sliderPosition(
  priceText: string,
  mark: number,
  tick: number,
  slider: TickSlider,
): number {
  const price = Number(priceText);
  const index = priceText.trim() !== "" && Number.isFinite(price) ? price / tick : mark / tick;
  return Math.min(slider.max, Math.max(slider.min, Math.round(index)));
}

export function priceAtTick(index: number, tick: number, decimals: number): string {
  return (index * tick).toFixed(decimals);
}
