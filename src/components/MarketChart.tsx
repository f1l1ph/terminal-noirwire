"use client";

import {
  createChart,
  LineStyle,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LineData,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatDecimal } from "@/lib/format";
import type { ConnectionState } from "@/lib/market-data/socket";
import { priceDecimalsOf } from "@/lib/market-data/precision";
import {
  changePercent,
  HISTORY_RANGES,
  RANGE_SPECS,
  rangeStartPrice,
  REFERENCE_LABEL,
  type HistoryRange,
  type ReferenceCandle,
} from "@/lib/market-data/reference-history";
import { useReferenceHistory } from "@/lib/market-data/useReferenceHistory";
import type { Candle, MarketInfo, PublicFill } from "@/lib/market-data/types";

const UP = "#75bc97";
const DOWN = "#f18d80";
const MARK_LINE = "#e8e6e1";
const MARK_LINE_STALE = "#b08a3a";

type ChartMode = "area" | "candles";

function toUtcSeconds(epochMs: number): UTCTimestamp {
  return Math.floor(epochMs / 1000) as UTCTimestamp;
}

function formatChartTime(seconds: number, range: HistoryRange): string {
  const date = new Date(seconds * 1000);
  if (range === "1H" || range === "1D") {
    return date.toLocaleString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fromVenueCandle(candle: Candle): ReferenceCandle {
  return {
    time: toUtcSeconds(candle.startMs),
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
  };
}

interface Readout {
  price: number;
  time: number;
}

export function MarketChart({
  market,
  candles,
  mark,
  publicFills,
  ownSequences,
  loading,
  markStale = false,
}: {
  market: MarketInfo | undefined;
  /** The venue's own candles: drawn only when the reference history is unavailable and they hold at least two. */
  interval: string;
  candles: Candle[];
  /** The one current price. The chart ends at it and draws a dashed line there. */
  mark: { price: string; time: number } | null;
  publicFills: PublicFill[];
  /** This trader's own fills' sequence numbers (mode-agnostic; see PublicTape.tsx). */
  ownSequences: ReadonlySet<number>;
  /** Unused by the chart now: the header states the connection. */
  connectionState: ConnectionState;
  loading: boolean;
  /** Unused by the chart now: the reference history retries itself every minute. */
  fetchFailed: boolean;
  /** Past the freshness window: the dashed mark line turns amber. */
  markStale?: boolean;
  /** Unused by the chart now. */
  onRetry: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const areaRef = useRef<ISeriesApi<"Area"> | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const priceDecimals = market ? priceDecimalsOf(market) : 2;
  const priceDecimalsRef = useRef(priceDecimals);
  const [range, setRange] = useState<HistoryRange>("1D");
  const [mode, setMode] = useState<ChartMode>("area");
  const [readout, setReadout] = useState<Readout | null>(null);
  const reference = useReferenceHistory(range);

  useEffect(() => {
    priceDecimalsRef.current = priceDecimals;
  }, [priceDecimals]);

  const venueCandles = useMemo(
    () =>
      candles
        .map(fromVenueCandle)
        .filter((candle) => Object.values(candle).every(Number.isFinite))
        .sort((a, b) => a.time - b.time),
    [candles],
  );
  const usingReference = reference.candles.length >= 2;
  const series = useMemo<ReferenceCandle[]>(
    () => (usingReference ? reference.candles : venueCandles.length >= 2 ? venueCandles : []),
    [usingReference, reference.candles, venueCandles],
  );
  const hasSeries = series.length > 0;
  const markValue = mark ? Number(mark.price) : NaN;
  const hasMark = Number.isFinite(markValue);

  const lastClose = series.at(-1)?.close ?? null;
  const endPrice = hasMark ? markValue : lastClose;
  const rangeChange = endPrice === null ? null : changePercent(rangeStartPrice(series), endPrice);
  const trendColor = rangeChange !== null && rangeChange < 0 ? DOWN : UP;

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const priceFormat = {
      type: "price" as const,
      precision: priceDecimalsRef.current,
      minMove: 1 / 10 ** priceDecimalsRef.current,
    };
    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: { color: "transparent" },
        textColor: "#8d8b86",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
        attributionLogo: true,
      },
      grid: { horzLines: { color: "#1f2124" }, vertLines: { visible: false } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 2,
        fixLeftEdge: true,
        fixRightEdge: true,
      },
      crosshair: {
        vertLine: {
          color: "#515458",
          style: LineStyle.Dashed,
          width: 1,
          labelVisible: false,
        },
        horzLine: { visible: false, labelVisible: false },
      },
      handleScroll: false,
      handleScale: false,
    });
    const area = chart.addAreaSeries({
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerRadius: 4,
      priceFormat,
    });
    const candleSeries = chart.addCandlestickSeries({
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceLineVisible: false,
      lastValueVisible: false,
      visible: false,
      priceFormat,
    });

    chart.subscribeCrosshairMove((param: MouseEventParams) => {
      if (param.time === undefined) {
        setReadout(null);
        return;
      }
      const areaValue = param.seriesData.get(area) as LineData | undefined;
      const candleValue = param.seriesData.get(candleSeries) as CandlestickData | undefined;
      const price = areaValue?.value ?? candleValue?.close;
      setReadout(price === undefined ? null : { price, time: Number(param.time) });
    });

    chartRef.current = chart;
    areaRef.current = area;
    candleRef.current = candleSeries;

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      chart.resize(entry.contentRect.width, entry.contentRect.height);
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      areaRef.current = null;
      candleRef.current = null;
    };
  }, [market?.id]);

  useEffect(() => {
    areaRef.current?.applyOptions({
      visible: mode === "area",
      lineColor: trendColor,
      topColor: `${trendColor}40`,
      bottomColor: `${trendColor}00`,
    });
    candleRef.current?.applyOptions({ visible: mode === "candles" });
  }, [mode, trendColor, market?.id]);

  useEffect(() => {
    if (!areaRef.current || !candleRef.current) return;
    const lastTime = series.at(-1)?.time ?? 0;
    const markTime = toUtcSeconds(mark?.time ?? 0);
    const areaPoints = series.map((candle) => ({
      time: candle.time as UTCTimestamp,
      value: candle.close,
    }));
    if (hasMark && markTime > lastTime && areaPoints.length > 0) {
      areaPoints.push({ time: markTime, value: markValue });
    }
    try {
      areaRef.current.setData(areaPoints);
      candleRef.current.setData(
        series.map((candle) => ({
          time: candle.time as UTCTimestamp,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
        })),
      );
      if (areaPoints.length > 0) chartRef.current?.timeScale().fitContent();
    } catch {
      // Out-of-order or malformed points are dropped rather than throwing.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, mark, market?.id]);

  useEffect(() => {
    const area = areaRef.current;
    const candleSeries = candleRef.current;
    if (!area || !candleSeries || !hasSeries || !hasMark) return;
    const options = {
      price: markValue,
      color: markStale ? MARK_LINE_STALE : MARK_LINE,
      lineWidth: 1 as const,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: "",
    };
    const lines: [ISeriesApi<"Area"> | ISeriesApi<"Candlestick">, IPriceLine][] = [
      [area, area.createPriceLine(options)],
      [candleSeries, candleSeries.createPriceLine(options)],
    ];
    return () => {
      for (const [owner, line] of lines) owner.removePriceLine(line);
    };
  }, [markValue, markStale, hasSeries, hasMark, market?.id]);

  const ownMarkers = useMemo(() => {
    const first = series[0]?.time;
    const last = series.at(-1)?.time;
    if (first === undefined || last === undefined) return [];
    const bucketMs = RANGE_SPECS[range].granularitySec * 1000;
    const byBucket = new Map<number, number>();
    for (const fill of publicFills) {
      if (!ownSequences.has(fill.sequence)) continue;
      const bucket = Math.floor(fill.timestampMs / bucketMs) * bucketMs;
      byBucket.set(bucket, (byBucket.get(bucket) ?? 0) + 1);
    }
    const markers: SeriesMarker<Time>[] = [];
    for (const [bucket, count] of [...byBucket.entries()].sort(([a], [b]) => a - b)) {
      const time = toUtcSeconds(bucket);
      if (time < first || time > last) continue;
      markers.push({
        time,
        position: "aboveBar",
        color: "#f5f3ee",
        shape: "circle",
        text: count > 1 ? `×${count}` : undefined,
      });
    }
    return markers;
  }, [series, publicFills, ownSequences, range]);

  useEffect(() => {
    try {
      areaRef.current?.setMarkers(ownMarkers);
      candleRef.current?.setMarkers(ownMarkers);
    } catch {
      // Markers are decorative; a malformed set is dropped rather than throwing.
    }
  }, [ownMarkers]);

  const noSeries = !hasSeries;
  const waiting = noSeries && (reference.status === "loading" || loading);

  const caption = usingReference
    ? REFERENCE_LABEL
    : noSeries
      ? "History unavailable"
      : "Venue price history. Reference history unavailable";

  const toggle = (active: boolean) =>
    `rounded-tile min-h-8 px-2.5 text-[12px] ${
      active ? "bg-elevated text-ink-strong" : "text-dim hover:bg-surface-raised"
    }`;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-1 pb-1">
        <div className="flex gap-1" role="group" aria-label="Chart period">
          {HISTORY_RANGES.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={range === option}
              onClick={() => setRange(option)}
              className={toggle(range === option)}
            >
              {option}
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-1" role="group" aria-label="Chart style">
          <button
            type="button"
            aria-pressed={mode === "area"}
            onClick={() => setMode("area")}
            className={toggle(mode === "area")}
          >
            Line
          </button>
          <button
            type="button"
            aria-pressed={mode === "candles"}
            onClick={() => setMode("candles")}
            className={toggle(mode === "candles")}
          >
            Candles
          </button>
        </div>
      </div>
      <div className="relative min-h-0 min-w-0 flex-1">
        <div ref={containerRef} className="h-full w-full" data-testid="market-chart" />
        {readout && !noSeries && (
          <div
            className="tnum bg-surface/80 rounded-tile pointer-events-none absolute top-1 left-1 z-10 flex items-center gap-2 px-2 py-0.5 text-[12px]"
            aria-live="off"
          >
            <span className="text-ink-strong">${formatDecimal(readout.price, priceDecimals)}</span>
            <span className="text-faint">{formatChartTime(readout.time, range)}</span>
          </div>
        )}
        {noSeries && (
          <div
            role="status"
            className="text-dim absolute inset-0 flex flex-col items-center justify-center gap-1 text-[13px]"
          >
            <p className="text-ink">{waiting ? "Loading price history" : "History unavailable"}</p>
            {!waiting && hasMark && (
              <p className="text-faint text-[12px]">
                Current price ${formatDecimal(markValue, priceDecimals)}
              </p>
            )}
          </div>
        )}
      </div>
      <div className="text-faint flex items-center gap-3 px-1 pt-1 text-[11px]">
        <span>{caption}</span>
        {ownMarkers.length > 0 && (
          <span className="ml-auto flex items-center gap-1.5">
            <span
              className="inline-flex h-2 w-2 rounded-full"
              style={{ backgroundColor: "#f5f3ee" }}
            />
            your fills
          </span>
        )}
      </div>
    </div>
  );
}
