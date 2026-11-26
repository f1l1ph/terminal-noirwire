"use client";

import { useEffect, useRef, useState } from "react";
import type { Mood } from "@/lib/trading/positionMood";
import { funToneVar } from "@/lib/trading/tripwire";

/** The outer strip of the viewport the ring draws in; nothing of it, spark included, leaves this band. */
const RING_BAND_PX = 3;
/** The window's own corner radius; the ring arc stays concentric with it. */
const WINDOW_CORNER_RADIUS_PX = 10;
/** The path runs along the middle of the band, so the widest stroke fills it edge to edge. */
const PATH_INSET_PX = RING_BAND_PX / 2;
const CORNER_RADIUS_PX = WINDOW_CORNER_RADIUS_PX - PATH_INSET_PX;
const THIN_STROKE_PX = 1.5;
const STRONG_STROKE_PX = RING_BAND_PX;
const SPARK_STROKE_PX = RING_BAND_PX;
/** Visible length of the bright dash at each arm's tip, round caps included. */
const SPARK_LENGTH_PX = 14;
/** Light opacity in the gutters and seams, which carry no text. */
const GUTTER_LIGHT_PERCENT = 85;
/** Light opacity on the footer strip at full intensity, per tone, set so the footer text keeps 4.5:1. */
const FOOTER_LIGHT_PERCENT = { danger: 22, profit: 13 } as const;
const FOOTER_HEIGHT_PX = 36;
const FOOTER_BLEND_PX = 28;
/** Strength follows intensity to this power, so a half-way price already glows. */
const LIGHT_STRENGTH_EXPONENT = 0.75;
/** How far the light reaches, as a share of the screen height, at no intensity and at full intensity. */
const LIGHT_REACH_MIN_PERCENT = 15;
const LIGHT_REACH_MAX_PERCENT = 60;
const LIGHT_MIDPOINT_SHARE = 0.4;
const GLOW_STRENGTH_PERCENT = 90;
const SPARK_FLASH_MS = 400;
const SPARK_MIN_PROGRESS = 0.01;
const SHIMMER_LENGTH_FRACTION = 0.14;
const RING_OPACITY_EXPONENT = 0.6;
const SPARK_WHITE_PERCENT = 60;
const SHIMMER_WHITE_PERCENT = 30;
/** Wide soft glow first, tight bright glow second: stroke width and share of the glow strength. */
const GLOW_LAYERS = [
  { widthPx: 22, share: 0.4 },
  { widthPx: 10, share: 0.8 },
] as const;

interface Size {
  width: number;
  height: number;
}

interface ArmGeometry {
  left: string;
  right: string;
  length: number;
}

function tone(color: string, percent: number): string {
  return `color-mix(in oklab, ${color} ${percent}%, transparent)`;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Both arms from the top centre round the rounded corners to the bottom centre, inside the band; each is `length` long. */
function armGeometry({ width, height }: Size): ArmGeometry {
  const r = CORNER_RADIUS_PX;
  const near = PATH_INSET_PX;
  const corner = near + r;
  const far = { x: width - near, y: height - near };
  const farCorner = { x: width - corner, y: height - corner };
  const mid = width / 2;
  const left = `M${mid} ${near} H${corner} A${r} ${r} 0 0 0 ${near} ${corner} V${farCorner.y} A${r} ${r} 0 0 0 ${corner} ${far.y} H${mid}`;
  const right = `M${mid} ${near} H${farCorner.x} A${r} ${r} 0 0 1 ${far.x} ${corner} V${farCorner.y} A${r} ${r} 0 0 1 ${farCorner.x} ${far.y} H${mid}`;
  const length = width + height - 4 * corner + Math.PI * r;
  return { left, right, length };
}

function useElementSize(element: HTMLElement | null): Size | null {
  const [size, setSize] = useState<Size | null>(null);
  useEffect(() => {
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return size;
}

function Arms({
  geometry,
  progress,
  color,
  strokePx,
  opacity,
}: {
  geometry: ArmGeometry;
  progress: number;
  color: string;
  strokePx: number;
  opacity: number;
}) {
  return (
    <>
      {[geometry.left, geometry.right].map((d) => (
        <path
          key={d}
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={strokePx}
          strokeDasharray={`${geometry.length} ${geometry.length}`}
          strokeDashoffset={geometry.length * (1 - progress)}
          className="fun-fuse-arm"
          style={{ opacity }}
        />
      ))}
    </>
  );
}

function SparkHeads({
  geometry,
  progress,
  color,
  opacity,
}: {
  geometry: ArmGeometry;
  progress: number;
  color: string;
  opacity: number;
}) {
  const ref = useRef<SVGGElement>(null);
  const sparkColor = `color-mix(in oklab, ${color} ${SPARK_WHITE_PERCENT}%, white)`;
  useEffect(() => {
    if (prefersReducedMotion()) return;
    ref.current?.querySelectorAll("path").forEach((path) =>
      path.animate([{ stroke: "white" }, { stroke: sparkColor }], {
        duration: SPARK_FLASH_MS,
        easing: "ease-out",
      }),
    );
  }, [progress, sparkColor]);
  const dash = SPARK_LENGTH_PX - SPARK_STROKE_PX;
  const tipOffset = SPARK_LENGTH_PX - SPARK_STROKE_PX / 2;
  return (
    <g ref={ref}>
      {[geometry.left, geometry.right].map((d) => (
        <path
          key={d}
          d={d}
          fill="none"
          stroke={sparkColor}
          strokeWidth={SPARK_STROKE_PX}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${geometry.length * 2}`}
          strokeDashoffset={tipOffset - geometry.length * progress}
          className="fun-fuse-arm"
          style={{ opacity: progress < SPARK_MIN_PROGRESS ? 0 : opacity }}
        />
      ))}
    </g>
  );
}

function Shimmer({ geometry, color }: { geometry: ArmGeometry; color: string }) {
  const dash = geometry.length * SHIMMER_LENGTH_FRACTION;
  return (
    <g
      className="fun-fuse-shimmer"
      style={
        {
          "--fuse-shimmer-from": dash,
          "--fuse-shimmer-to": -geometry.length,
        } as React.CSSProperties
      }
    >
      {[geometry.left, geometry.right].map((d) => (
        <path
          key={d}
          d={d}
          fill="none"
          stroke={`color-mix(in oklab, ${color} ${SHIMMER_WHITE_PERCENT}%, white)`}
          strokeWidth={RING_BAND_PX}
          strokeDasharray={`${dash} ${geometry.length * 2}`}
        />
      ))}
    </g>
  );
}

function lightBackground(mood: Mood, color: string): string {
  const strength = Math.pow(mood.intensity, LIGHT_STRENGTH_EXPONENT);
  const reach =
    LIGHT_REACH_MIN_PERCENT + (LIGHT_REACH_MAX_PERCENT - LIGHT_REACH_MIN_PERCENT) * mood.intensity;
  const gutter = GUTTER_LIGHT_PERCENT * strength;
  const footer = FOOTER_LIGHT_PERCENT[mood.tone === "danger" ? "danger" : "profit"] * strength;
  const fade = `${tone(color, gutter * LIGHT_MIDPOINT_SHARE)} ${reach / 2}%, transparent ${reach}%`;
  if (mood.tone === "danger") {
    const blendEnd = FOOTER_HEIGHT_PX + FOOTER_BLEND_PX;
    return `linear-gradient(to top, ${tone(color, footer)} 0, ${tone(color, footer)} ${FOOTER_HEIGHT_PX}px, ${tone(color, gutter)} ${blendEnd}px, ${fade})`;
  }
  const floor = `linear-gradient(to top, ${tone(color, footer)} 0, ${tone(color, footer)} ${FOOTER_HEIGHT_PX}px, transparent ${FOOTER_HEIGHT_PX}px)`;
  return `${floor}, linear-gradient(to bottom, ${tone(color, gutter)} 0, ${fade})`;
}

/**
 * The Fuse: two arms creep from the top centre down both sides of the
 * screen and meet at the bottom centre exactly when the price reaches the
 * target. Behind the panels a lamp light rises from the bottom edge in red,
 * or comes from the top in green, so it shows in the gutters and seams only.
 * A display of distance; it never takes a click or focus.
 */
export function FunFuse({ mood }: { mood: Mood }) {
  const [ring, setRing] = useState<HTMLDivElement | null>(null);
  const size = useElementSize(ring);
  if (mood.tone === null) return null;
  const color = funToneVar(mood.tone);
  const reached = mood.progress >= 1;
  const strokePx = THIN_STROKE_PX + (STRONG_STROKE_PX - THIN_STROKE_PX) * mood.intensity;
  const ringOpacity = Math.pow(mood.intensity, RING_OPACITY_EXPONENT);
  const geometry = size && armGeometry(size);
  return (
    <>
      <div
        aria-hidden="true"
        data-testid="fun-fuse-light"
        data-tone={mood.tone}
        className="pointer-events-none fixed inset-0 -z-10"
        style={{ background: lightBackground(mood, color) }}
      >
        {geometry && size && (
          <svg className="absolute inset-0" width={size.width} height={size.height}>
            {GLOW_LAYERS.map(({ widthPx, share }) => (
              <Arms
                key={widthPx}
                geometry={geometry}
                progress={mood.progress}
                color={tone(color, GLOW_STRENGTH_PERCENT * share * mood.intensity)}
                strokePx={widthPx}
                opacity={1}
              />
            ))}
          </svg>
        )}
      </div>
      <div
        ref={setRing}
        aria-hidden="true"
        data-testid="fun-fuse-ring"
        data-tone={mood.tone}
        data-reached={reached}
        className="pointer-events-none fixed inset-0 z-[120]"
      >
        {geometry && size && (
          <svg
            className={reached && mood.tone === "danger" ? "fun-fuse-flash" : undefined}
            width={size.width}
            height={size.height}
          >
            <Arms
              geometry={geometry}
              progress={mood.progress}
              color={color}
              strokePx={strokePx}
              opacity={ringOpacity}
            />
            <SparkHeads
              geometry={geometry}
              progress={mood.progress}
              color={color}
              opacity={ringOpacity}
            />
            {reached && mood.tone === "profit" && <Shimmer geometry={geometry} color={color} />}
          </svg>
        )}
      </div>
    </>
  );
}
