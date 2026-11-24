import { notFound } from "next/navigation";
import type { Mood, MoodReason, MoodState } from "@/lib/trading/positionMood";
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

export default async function DevFunPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const { mood: requested, intensity, wallet } = await searchParams;
  const state = STATES.find((item) => item === requested) ?? "calm";
  const level = Math.min(Math.max(Number(intensity ?? "1") || 0, 0), 1);
  const mood: Mood = {
    state,
    intensity: state === "calm" || state === "unknown" ? 0 : level,
    reason: REASONS[state],
  };
  return (
    <FunFixture
      mood={mood}
      wallet={wallet === "locked" || wallet === "unsaved" ? wallet : "plain"}
    />
  );
}
