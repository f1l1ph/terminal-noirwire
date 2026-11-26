import type {
  ISeriesPrimitive,
  ISeriesPrimitivePaneRenderer,
  ISeriesPrimitivePaneView,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";
import { tripwireShadeAlpha } from "@/lib/trading/tripwire";

const RUNWAY_WIDTH_FRACTION = 0.18;
const BLOOM_PX = 10;

interface TripwireShade {
  markPrice: number;
  targetPrice: number;
  color: string;
  intensity: number;
}

function withAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

/**
 * Shades the stretch of chart between the mark and the target on the right
 * of the plot, fading to nothing leftward, and a short bloom just beyond the
 * target line. Draws on its own series only while that series is visible, so
 * attaching it to both series paints once.
 */
export class TripwirePrimitive implements ISeriesPrimitive<Time> {
  private shade: TripwireShade | null = null;
  private attachedTo: SeriesAttachedParameter<Time, SeriesType> | null = null;

  private readonly paneView: ISeriesPrimitivePaneView = {
    zOrder: () => "bottom",
    renderer: (): ISeriesPrimitivePaneRenderer | null => {
      const attached = this.attachedTo;
      const shade = this.shade;
      if (!attached || !shade || !attached.series.options().visible) return null;
      const markY = attached.series.priceToCoordinate(shade.markPrice);
      const targetY = attached.series.priceToCoordinate(shade.targetPrice);
      if (markY === null || targetY === null) return null;
      return {
        draw: () => {},
        drawBackground: (target) =>
          target.useBitmapCoordinateSpace(({ context, bitmapSize, verticalPixelRatio }) => {
            const alpha = tripwireShadeAlpha(shade.intensity);
            if (alpha <= 0) return;
            const width = bitmapSize.width;
            const runwayLeft = Math.round(width * (1 - RUNWAY_WIDTH_FRACTION));
            const top = Math.min(markY, targetY) * verticalPixelRatio;
            const height = Math.abs(markY - targetY) * verticalPixelRatio;
            const runway = context.createLinearGradient(runwayLeft, 0, width, 0);
            runway.addColorStop(0, withAlpha(shade.color, 0));
            runway.addColorStop(1, withAlpha(shade.color, alpha));
            context.fillStyle = runway;
            context.fillRect(runwayLeft, top, width - runwayLeft, height);

            const beyondDown = targetY > markY;
            const bloomPx = BLOOM_PX * verticalPixelRatio;
            const edge = targetY * verticalPixelRatio;
            const far = beyondDown ? edge + bloomPx : edge - bloomPx;
            const bloom = context.createLinearGradient(0, edge, 0, far);
            bloom.addColorStop(0, withAlpha(shade.color, alpha));
            bloom.addColorStop(1, withAlpha(shade.color, 0));
            context.fillStyle = bloom;
            context.fillRect(0, Math.min(edge, far), width, bloomPx);
          }),
      };
    },
  };

  attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
    this.attachedTo = param;
  }

  detached(): void {
    this.attachedTo = null;
  }

  paneViews(): readonly ISeriesPrimitivePaneView[] {
    return [this.paneView];
  }

  /** Redraws only when an input differs from the last one. */
  setShade(next: TripwireShade | null): void {
    const current = this.shade;
    const same =
      current === next ||
      (current !== null &&
        next !== null &&
        current.markPrice === next.markPrice &&
        current.targetPrice === next.targetPrice &&
        current.color === next.color &&
        current.intensity === next.intensity);
    if (same) return;
    this.shade = next;
    this.attachedTo?.requestUpdate();
  }
}
