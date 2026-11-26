"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Mood } from "@/lib/trading/positionMood";

const TripwireContext = createContext<Mood | null>(null);

/** Carries the mood the Tripwire style follows to the chart and the position cards; null when that style is off. */
export function TripwireProvider({ mood, children }: { mood: Mood | null; children: ReactNode }) {
  return <TripwireContext.Provider value={mood}>{children}</TripwireContext.Provider>;
}

export function useTripwireMood(): Mood | null {
  return useContext(TripwireContext);
}
