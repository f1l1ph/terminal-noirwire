"use client";

import { useMemo, useState } from "react";
import type { PositionTriggerControls } from "@/components/hooks/usePositionTriggers";
import {
  CALM_MOOD,
  nextMood,
  rawMood,
  sameMood,
  type LocalTriggerReading,
  type Mood,
  type MoodInput,
} from "@/lib/trading/positionMood";
import type { Position, TriggerKind } from "@/lib/trading/types";

interface Source {
  /** The wallet's owner address; a different owner starts from a calm mood, not the previous wallet's. */
  owner: string;
  /** Nothing is computed, and the mood stays calm, while Fun mode is off. */
  enabled: boolean;
  positions: Record<string, Position>;
  collateral: string | null;
  exposureUnreadable: boolean;
  marks: Record<string, { price: string; time: number } | null>;
  now: number;
  triggers: PositionTriggerControls | null;
  /** Keep this identity stable between renders; a new one recomputes the mood. */
  entryLiquidation: MoodInput["entryLiquidation"];
}

function readingFrom(
  triggers: PositionTriggerControls | null,
  market: string,
  kind: TriggerKind,
): LocalTriggerReading | null {
  if (!triggers) return null;
  const local = triggers.localFor(market)[kind];
  const status = triggers.statusesFor(market);
  if (!local || !status) return null;
  return {
    price: local.price,
    long: local.long,
    armed: !status.stale && status[kind].state === "armed",
  };
}

/** How close the open positions are to liquidation, stop loss or take profit, from data the terminal already holds. */
export function usePositionMood(source: Source): Mood {
  const {
    owner,
    enabled,
    positions,
    collateral,
    exposureUnreadable,
    marks,
    now,
    triggers,
    entryLiquidation,
  } = source;
  const raw = useMemo(
    () =>
      enabled
        ? rawMood({
            positions: Object.values(positions),
            collateral,
            exposureUnreadable,
            marks,
            now,
            trigger: (market, kind) => readingFrom(triggers, market, kind),
            entryLiquidation,
          })
        : null,
    [enabled, positions, collateral, exposureUnreadable, marks, now, triggers, entryLiquidation],
  );
  const [shown, setShown] = useState({ owner, mood: CALM_MOOD });
  const previous = shown.owner === owner ? shown.mood : CALM_MOOD;
  const next = raw === null ? CALM_MOOD : nextMood(previous, raw);
  if (shown.owner !== owner || !sameMood(shown.mood, next)) setShown({ owner, mood: next });
  return next;
}
