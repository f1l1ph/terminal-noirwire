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

function defaultDangerReason(mood: Mood): Gauge["dangerReason"] {
  return mood.reason === "liquidation" ? "liquidation" : "stopLoss";
}

export default async function DevFunPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const { mood: requested, intensity, wallet, gauge: marker, labels, tp } = await searchParams;
  const state = STATES.find((item) => item === requested) ?? "calm";
  const level = Math.min(Math.max(Number(intensity ?? "1") || 0, 0), 1);
  const mood: Mood = {
    state,
    intensity: state === "calm" || state === "unknown" ? 0 : level,
    reason: REASONS[state],
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
      wallet={wallet === "locked" || wallet === "unsaved" ? wallet : "plain"}
    />
  );
}
