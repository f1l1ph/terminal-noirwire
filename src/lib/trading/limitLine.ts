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

/** The program's crossing band: how far from the mark a bid may sit above it and an ask below it. */
export interface CrossingBand {
  side: Side;
  bandBps: number;
}

/** Whether a bid sits above the band, or an ask below it. */
function beyondBand(price: number, mark: number, { side, bandBps }: CrossingBand): boolean {
  const band = bandBps / 10_000;
  return side === "buy" ? price > mark * (1 + band) : price < mark * (1 - band);
}

/**
 * The price the chart should draw for the form's draft, or null when there is
 * nothing valid to draw: no usable limit price, or one the program would
 * refuse because it sits outside the crossing band around `mark`.
 */
export function limitLineFor({
  orderType,
  priceText,
  side,
  mark,
  bandBps,
}: {
  orderType: "market" | "limit";
  priceText: string;
  side: Side;
  mark?: number;
  bandBps?: number;
}): LimitLine | null {
  if (orderType !== "limit" || priceText.trim() === "") return null;
  const price = Number(priceText);
  if (!Number.isFinite(price) || price <= 0) return null;
  if (
    mark !== undefined &&
    mark > 0 &&
    bandBps !== undefined &&
    beyondBand(price, mark, { side, bandBps })
  ) {
    return null;
  }
  return { price, side };
}

/**
 * The slider runs in whole ticks: plus or minus 10 percent of the mark, so
 * every position is on the grid. With a `band`, the side the program refuses
 * past it stops there: a bid's top and an ask's bottom.
 */
export function tickSlider(mark: number, tick: number, band?: CrossingBand): TickSlider | null {
  if (!(mark > 0) || !(tick > 0)) return null;
  const bandSpan = band ? band.bandBps / 10_000 : LIMIT_SLIDER_SPAN;
  const upSpan = band?.side === "buy" ? Math.min(LIMIT_SLIDER_SPAN, bandSpan) : LIMIT_SLIDER_SPAN;
  const downSpan =
    band?.side === "sell" ? Math.min(LIMIT_SLIDER_SPAN, bandSpan) : LIMIT_SLIDER_SPAN;
  const min = Math.max(1, Math.ceil((mark * (1 - downSpan)) / tick));
  const max = Math.floor((mark * (1 + upSpan)) / tick);
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
