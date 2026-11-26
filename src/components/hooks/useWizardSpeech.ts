"use client";

import { useState } from "react";
import { useFunSwitchedOnCount } from "@/components/hooks/useFunMode";
import { advanceSpeech, firstSpeech, type Speech } from "@/components/wizardSpeech";
import type { Mood } from "@/lib/trading/positionMood";

/** Server and first client render must agree, so the opening line is never random. */
const firstLineOfPool = () => 0;

/** The wizard's current line, shared by the header and the pop-out so both always show the same one. */
export function useWizardSpeech(mood: Mood): Speech {
  const greetings = useFunSwitchedOnCount();
  const [spoken, setSpoken] = useState(() => firstSpeech(mood, greetings, firstLineOfPool));
  const next = advanceSpeech(spoken, mood, greetings);
  if (next !== spoken) setSpoken(next);
  return next;
}
