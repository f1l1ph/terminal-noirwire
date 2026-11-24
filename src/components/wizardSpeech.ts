import type { Mood, MoodReason, MoodState } from "@/lib/trading/positionMood";

export type LinePool = MoodState | "greeting";

export const WIZARD_LINES: Record<MoodState, readonly string[]> = {
  calm: [
    "All quiet. Wand at rest.",
    "Sir, this is a terminal.",
    "Probably nothing.",
    "Charts, but make it cozy.",
  ],
  nearProfit: ["WAGMI? The wand is hopeful.", "Number go up energy.", "Few understand this setup."],
  atProfit: ["We're so back.", "Mark met your take profit price.", "Tiny wizard, big grin."],
  nearDanger: [
    "The hat looks concerned.",
    "NGMI? Too early to call.",
    "Wizard is watching the margin.",
  ],
  atDanger: [
    "It's so over. Check the numbers.",
    "This is fine. Check your margin.",
    "Sir, this is a casino. Read the risk.",
  ],
  unknown: ["Wizard is napping.", "Nap time. Numbers first."],
};

export const GREETING_LINES: readonly string[] = [
  "Gm. I react to your positions. Orders stay yours.",
  "Wand charged. Just vibes, your orders don't change.",
  "Vibes enabled. Numbers unchanged.",
];

const POOLS: Record<LinePool, readonly string[]> = { ...WIZARD_LINES, greeting: GREETING_LINES };

/** The plain-text fact behind the mood, so colour and a drawing are never the only signal. */
export function moodFact(mood: { state: MoodState; reason: MoodReason | null }): string | null {
  switch (mood.state) {
    case "nearDanger":
      return mood.reason === "liquidation" ? "Near estimated liquidation" : "Near stop loss";
    case "atDanger":
      return mood.reason === "liquidation" ? "At estimated liquidation" : "Mark at stop loss";
    case "nearProfit":
      return "Near take profit";
    case "atProfit":
      return "Mark at take profit";
    case "unknown":
      return mood.reason === "accountUnreadable" ? "Account risk not readable" : "No fresh price";
    case "calm":
      return null;
  }
}

/** A random line from the pool, never the one shown just before it unless the pool has no other. */
export function pickLine(
  pool: LinePool,
  previous: string | null,
  random: () => number = Math.random,
): string {
  const all = POOLS[pool];
  const choices = all.length > 1 ? all.filter((line) => line !== previous) : all;
  const index = Math.min(Math.floor(random() * choices.length), choices.length - 1);
  return choices[index]!;
}

export interface Speech {
  state: MoodState;
  reason: MoodReason | null;
  line: string;
  /** Counts every new line, so a repeat of the same state still reads as a new entry. */
  entry: number;
  greeting: boolean;
  /** How many times Fun mode had been switched on when this was last updated. */
  greetings: number;
}

export function firstSpeech(mood: Mood, greetings: number, random?: () => number): Speech {
  return {
    state: mood.state,
    reason: mood.reason,
    line: pickLine(mood.state, null, random),
    entry: 1,
    greeting: false,
    greetings,
  };
}

/**
 * What the wizard says now. A new line is picked when a state is entered, and
 * a greeting when Fun mode is switched on in a calm moment; never on a tick.
 */
export function advanceSpeech(
  previous: Speech,
  mood: Mood,
  greetings: number,
  random?: () => number,
): Speech {
  if (previous.state !== mood.state) {
    return {
      state: mood.state,
      reason: mood.reason,
      line: pickLine(mood.state, previous.line, random),
      entry: previous.entry + 1,
      greeting: false,
      greetings,
    };
  }
  if (greetings !== previous.greetings) {
    return {
      ...previous,
      line: pickLine("greeting", previous.line, random),
      entry: previous.entry + 1,
      greeting: true,
      greetings,
    };
  }
  return previous.reason === mood.reason ? previous : { ...previous, reason: mood.reason };
}
