"use client";

import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import type { Candle, PublicFill } from "@/lib/market-data/types";

function toUtcSeconds(epochMs: number): UTCTimestamp {
  return Math.floor(epochMs / 1000) as UTCTimestamp;
}

export function MarketChart({
  candles,
  mark,
  fills,
  stale,
}: {
  candles: Candle[];
  mark: { price: string; time: number } | null;
  fills: PublicFill[];
  stale: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const chartRef = useRef<IChartApi | null>(null);

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
    const series = chart.addLineSeries({
      color: "#e8e6e1",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    chartRef.current = chart;
    seriesRef.current = series;

    // A plain resize observer that only calls chart.resize(): the library's
    // own `autoSize` option wires an internal one, which threw an unrelated
    // internal error in this build's Chromium (see docs/BUILD-NOTES.md).
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
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current) return;
    try {
      seriesRef.current.setData(
        candles.map((candle) => ({
          time: toUtcSeconds(candle.startTime),
          value: Number(candle.close),
        })),
      );
    } catch {
      // Malformed or out-of-order candle data is dropped rather than throwing.
    }
  }, [candles]);

  useEffect(() => {
    if (!seriesRef.current || !mark) return;
    const value = Number(mark.price);
    if (!Number.isFinite(value)) return;
    try {
      seriesRef.current.update({ time: toUtcSeconds(mark.time), value });
    } catch {
      // A mark older than the latest candle point is dropped rather than throwing.
    }
  }, [mark]);

  useEffect(() => {
    if (!seriesRef.current) return;
    // The tape is newest-first; markers must be given oldest-first.
    const ascending = [...fills].sort((a, b) => a.time - b.time).slice(-60);
    try {
      seriesRef.current.setMarkers(
        ascending.map((fill) => ({
          time: toUtcSeconds(fill.time),
          position: "inBar" as const,
          color: "#8d8b86",
          shape: "circle" as const,
        })),
      );
    } catch {
      // Markers are decorative; a malformed set is dropped rather than throwing.
    }
  }, [fills]);

  return (
    <div className="relative">
      <div ref={containerRef} className="h-[320px] w-full" data-testid="market-chart" />
      {stale && (
        <div
          role="status"
          className="bg-surface/85 rounded-panel text-faint absolute inset-0 flex items-center justify-center text-[13px]"
        >
          Mark unavailable
        </div>
      )}
    </div>
  );
}
