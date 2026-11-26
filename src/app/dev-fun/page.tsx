import { notFound } from "next/navigation";
import {
  GAUGE_ROOM_BPS,
  type Gauge,
  type Mood,
  type MoodReason,
  type MoodState,
} from "@/lib/trading/positionMood";
import { FunFixture } from "./FunFixture";

const STATES: readonly MoodState[] = [
  "calm",
  "nearProfit",
  "atProfit",
  "nearDanger",
  "atDanger",
  "unknown",
];

const REASONS: Record<MoodState, MoodReason | null> = {
  calm: null,
  nearProfit: "takeProfit",
  atProfit: "takeProfit",
  nearDanger: "stopLoss",
  atDanger: "liquidation",
  unknown: "noPrice",
};

const DEFAULT_MARKER: Record<MoodState, number> = {
  calm: 0.5,
  nearProfit: 0.85,
  atProfit: 1,
  nearDanger: 0.15,
  atDanger: 0,
  unknown: 0.5,
};

const SCENE_ENTRY = 71.27;
const SCENE_STOP = 70.4;
const SCENE_TAKE_PROFIT = 72.53;

/** A long from the entry: the mark sits `progress` of the way to the stop (danger) or to the take profit (profit). */
function sceneFor(tone: "danger" | "profit", progress: number) {
  const target = tone === "danger" ? SCENE_STOP : SCENE_TAKE_PROFIT;
  return {
    entry: SCENE_ENTRY,
    mark: SCENE_ENTRY + (target - SCENE_ENTRY) * progress,
    target: target.toFixed(2),
  };
}

const NEAR_FROM_PROGRESS = 0.5;

/** The wizard's band for a chosen tone and progress, as the live terminal would show it. */
function bandFor(tone: "danger" | "profit", progress: number): MoodState {
  if (progress >= 1) return tone === "danger" ? "atDanger" : "atProfit";
  if (progress >= NEAR_FROM_PROGRESS) return tone === "danger" ? "nearDanger" : "nearProfit";
  return "calm";
}

function defaultDangerReason(mood: Mood): Gauge["dangerReason"] {
  return mood.reason === "liquidation" ? "liquidation" : "stopLoss";
}

export default async function DevFunPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const {
    mood: requested,
    intensity,
    wallet,
    gauge: marker,
    labels,
    tp,
    tone: requestedTone,
    progress: requestedProgress,
    style,
  } = await searchParams;
  const toneOverride = requestedTone === "danger" || requestedTone === "profit";
  const overrideProgress = Math.min(Math.max(Number(requestedProgress ?? "1") || 0, 0), 1);
  const state = toneOverride
    ? bandFor(requestedTone, overrideProgress)
    : (STATES.find((item) => item === requested) ?? "calm");
  const level = Math.min(Math.max(Number(intensity ?? "1") || 0, 0), 1);
  const dangerous = state === "nearDanger" || state === "atDanger";
  const profitable = state === "nearProfit" || state === "atProfit";
  const shown = toneOverride || dangerous || profitable;
  const progress = toneOverride ? overrideProgress : shown ? Math.sqrt(level) : 0;
  const tone = toneOverride ? requestedTone : dangerous ? "danger" : profitable ? "profit" : null;
  const tripwire = style === "tripwire";
  const scene = tripwire && tone ? sceneFor(tone, progress) : null;
  const tonedReason: MoodReason =
    tone === "profit" ? "takeProfit" : scene ? "stopLoss" : "liquidation";
  const mood: Mood = {
    state,
    reason: toneOverride || scene ? tonedReason : REASONS[state],
    tone,
    intensity: toneOverride ? progress * progress : shown ? level : 0,
    progress,
    focus: shown
      ? {
          market: "SOL-PERP",
          price: scene ? scene.target : null,
          kind: tone === "profit" ? "takeProfit" : scene ? "stopLoss" : "liquidation",
        }
      : null,
  };
  const position = Math.min(Math.max(Number(marker ?? DEFAULT_MARKER[state]) || 0, 0), 1);
  const dangerReason =
    labels === "liq" ? "liquidation" : labels === "stop" ? "stopLoss" : defaultDangerReason(mood);
  const gauge: Gauge | null =
    state === "unknown"
      ? null
      : {
          dangerBps: position * GAUGE_ROOM_BPS,
          dangerReason,
          profitBps: tp === "0" ? null : (1 - position) * GAUGE_ROOM_BPS,
        };
  return (
    <FunFixture
      mood={mood}
      gauge={gauge}
      tintStyle={tripwire ? "tripwire" : "fuse"}
      scene={scene}
      wallet={wallet === "locked" || wallet === "unsaved" ? wallet : "plain"}
    />
  );
}
