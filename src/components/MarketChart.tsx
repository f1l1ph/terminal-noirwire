"use client";

import {
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatClockTime, formatDecimal, UNAVAILABLE } from "@/lib/format";
import type { ConnectionState } from "@/lib/market-data/socket";
import { priceDecimalsOf } from "@/lib/market-data/precision";
import type { Candle, MarketInfo, PublicFill } from "@/lib/market-data/types";
import { isOwnFill } from "@/lib/trading/tags";
import { btnGhost } from "@/components/ui/styles";

const MIN_VALID_CANDLES = 2;

function toUtcSeconds(epochMs: number): UTCTimestamp {
  return Math.floor(epochMs / 1000) as UTCTimestamp;
}

interface OhlcvLegend {
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  isLast: boolean;
}

export function MarketChart({
  market,
  candles,
  mark,
  publicFills,
  ownTags,
  connectionState,
  loading,
  onRetry,
}: {
  market: MarketInfo | undefined;
  candles: Candle[];
  mark: { price: string; time: number } | null;
  publicFills: PublicFill[];
  ownTags: ReadonlySet<string>;
  connectionState: ConnectionState;
  loading: boolean;
  onRetry: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const priceDecimals = market ? priceDecimalsOf(market) : 2;
  const [legend, setLegend] = useState<OhlcvLegend | null>(null);

  const priceDecimalsRef = useRef(priceDecimals);
  useEffect(() => {
    priceDecimalsRef.current = priceDecimals;
  }, [priceDecimals]);

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: { color: "transparent" },
        textColor: "#8d8b86",
        fontFamily: "var(--font-sans)",
        fontSize: 11,
      },
      grid: {
        horzLines: { color: "#272a2d" },
        vertLines: { visible: false },
      },
      rightPriceScale: { borderColor: "#36393c" },
      timeScale: { borderColor: "#36393c", timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: "#515458" }, horzLine: { color: "#515458" } },
      handleScroll: false,
      handleScale: false,
    });
    const candleSeries = chart.addCandlestickSeries({
      upColor: "#75bc97",
      downColor: "#f18d80",
      borderVisible: false,
      wickUpColor: "#75bc97",
      wickDownColor: "#f18d80",
      priceLineVisible: false,
      priceFormat: {
        type: "price",
        precision: priceDecimalsRef.current,
        minMove: 1 / 10 ** priceDecimalsRef.current,
      },
    });
    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      color: "#36393c",
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: 0.22 } });

    chart.subscribeCrosshairMove((param: MouseEventParams) => {
      const candleValue = param.seriesData.get(candleSeries) as CandlestickData | undefined;
      const volumeValue = param.seriesData.get(volumeSeries) as HistogramData | undefined;
      if (!candleValue) {
        setLegend(null);
        return;
      }
      setLegend({
        open: formatDecimal(candleValue.open, priceDecimalsRef.current),
        high: formatDecimal(candleValue.high, priceDecimalsRef.current),
        low: formatDecimal(candleValue.low, priceDecimalsRef.current),
        close: formatDecimal(candleValue.close, priceDecimalsRef.current),
        volume: volumeValue ? formatDecimal(volumeValue.value, 2) : UNAVAILABLE,
        isLast: false,
      });
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

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
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
    };
  }, [market?.id]);

  const hasEnoughData = candles.length >= MIN_VALID_CANDLES;

  useEffect(() => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current) return;
    if (!hasEnoughData) return;
    // lightweight-charts requires strictly ascending time; a REST snapshot
    // racing a websocket candle update is the one way this terminal could
    // otherwise hand it two candles out of order.
    const ordered = [...candles].sort((a, b) => a.startMs - b.startMs);
    try {
      candleSeriesRef.current.setData(
        ordered.map((candle) => ({
          time: toUtcSeconds(candle.startMs),
          open: Number(candle.open),
          high: Number(candle.high),
          low: Number(candle.low),
          close: Number(candle.close),
        })),
      );
      volumeSeriesRef.current.setData(
        ordered.map((candle) => ({
          time: toUtcSeconds(candle.startMs),
          value: Number(candle.volume),
          color: Number(candle.close) >= Number(candle.open) ? "#2e4536" : "#4a2e2a",
        })),
      );
      chartRef.current?.timeScale().fitContent();
      const lastCandle = ordered.at(-1);
      if (lastCandle && !legend) {
        setLegend({
          open: formatDecimal(lastCandle.open, priceDecimalsRef.current),
          high: formatDecimal(lastCandle.high, priceDecimalsRef.current),
          low: formatDecimal(lastCandle.low, priceDecimalsRef.current),
          close: formatDecimal(lastCandle.close, priceDecimalsRef.current),
          volume: formatDecimal(lastCandle.volume, 2),
          isLast: true,
        });
      }
    } catch {
      // Malformed or out-of-order candle data is dropped rather than throwing.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, hasEnoughData]);

  useEffect(() => {
    if (!candleSeriesRef.current || !mark) return;
    const value = Number(mark.price);
    if (!Number.isFinite(value)) return;
    const priceLine = candleSeriesRef.current.createPriceLine({
      price: value,
      color: "#e8e6e1",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: `mark ${formatClockTime(new Date(mark.time))}`,
    });
    return () => {
      candleSeriesRef.current?.removePriceLine(priceLine);
    };
  }, [mark]);

  useEffect(() => {
    if (!candleSeriesRef.current) return;
    const ascending = [...publicFills].sort((a, b) => a.timestampMs - b.timestampMs).slice(-80);
    try {
      candleSeriesRef.current.setMarkers(
        ascending.map((fill) => ({
          time: toUtcSeconds(fill.timestampMs),
          position: isOwnFill(fill, ownTags) ? ("aboveBar" as const) : ("inBar" as const),
          color: isOwnFill(fill, ownTags) ? "#f5f3ee" : "#515458",
          shape: "circle" as const,
        })),
      );
    } catch {
      // Markers are decorative; a malformed set is dropped rather than throwing.
    }
  }, [publicFills, ownTags]);

  const frozen = connectionState !== "open";
  const lastUpdateLabel = mark ? formatClockTime(new Date(mark.time)) : UNAVAILABLE;

  const overlay = useMemo(() => {
    if (frozen) {
      return {
        title: "Market data paused",
        detail: `Last update ${lastUpdateLabel}`,
        retry: false,
      };
    }
    if (loading) {
      return { title: "Loading 1m history", detail: null, retry: false };
    }
    if (!hasEnoughData) {
      return { title: "Price history unavailable", detail: "Not enough candles yet.", retry: true };
    }
    return null;
  }, [frozen, loading, hasEnoughData, lastUpdateLabel]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="text-faint flex items-center gap-3 px-1 pb-1 text-[11px]" aria-live="off">
        {legend ? (
          <span className="tnum">
            O {legend.open} H {legend.high} L {legend.low} C {legend.close} V {legend.volume}
            {legend.isLast ? " · close" : ""}
          </span>
        ) : (
          <span>Hover the chart for O H L C V</span>
        )}
        <span className="ml-auto flex items-center gap-2">
          <span
            className="inline-flex h-2 w-2 rounded-full"
            style={{ backgroundColor: "#f5f3ee" }}
          />
          yours
          <span
            className="inline-flex h-2 w-2 rounded-full"
            style={{ backgroundColor: "#515458" }}
          />
          public
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="h-full w-full" data-testid="market-chart" />
        {overlay && (
          <div
            role="status"
            className="chart-overlay rounded-panel text-dim absolute inset-0 flex flex-col items-center justify-center gap-2 text-[13px]"
          >
            <p className="text-ink">{overlay.title}</p>
            {overlay.detail && <p className="text-faint text-[12px]">{overlay.detail}</p>}
            {overlay.retry && (
              <button
                type="button"
                className={`${btnGhost} mt-1 h-8 px-3 text-[12px]`}
                onClick={onRetry}
              >
                Retry
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
