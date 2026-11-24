import { describe, expect, it } from "vitest";
import {
  advanceSpeech,
  firstSpeech,
  GREETING_LINES,
  pickLine,
  WIZARD_LINES,
} from "@/components/wizardSpeech";
import { CALM_MOOD, type Mood } from "@/lib/trading/positionMood";

describe("wizard line choice", () => {
  it("picks from the state's pool with the injected random source", () => {
    const pool = WIZARD_LINES.nearDanger;
    expect(pickLine("nearDanger", null, () => 0)).toBe(pool[0]);
    expect(pickLine("nearDanger", null, () => 0.999)).toBe(pool[pool.length - 1]);
  });

  it("never repeats the previous line when the pool has another", () => {
    for (const state of Object.keys(WIZARD_LINES) as (keyof typeof WIZARD_LINES)[]) {
      for (const previous of WIZARD_LINES[state]) {
        for (const roll of [0, 0.3, 0.6, 0.999]) {
          expect(pickLine(state, previous, () => roll)).not.toBe(previous);
        }
      }
    }
  });

  it("uses the greeting pool for greetings", () => {
    expect(GREETING_LINES.length).toBeGreaterThanOrEqual(2);
    expect(GREETING_LINES).toContain(pickLine("greeting", null, () => 0));
  });
});

describe("wizard speech", () => {
  const danger: Mood = { state: "atDanger", intensity: 1, reason: "liquidation" };
  const near: Mood = { state: "nearDanger", intensity: 0.5, reason: "stopLoss" };

  it("picks a new line, and a new entry, on every state change", () => {
    const first = advanceSpeech(firstSpeech(CALM_MOOD, 0), near, 0);
    const second = advanceSpeech(first, danger, 0);
    expect(second.entry).toBe(first.entry + 1);
    expect(second.line).not.toBe(first.line);
  });

  it("keeps the line while the state holds, even as intensity moves", () => {
    const first = advanceSpeech(firstSpeech(CALM_MOOD, 0), near, 0);
    expect(advanceSpeech(first, { ...near, intensity: 0.9 }, 0)).toBe(first);
  });

  it("greets when Fun mode is switched on, and not otherwise", () => {
    const calm = firstSpeech(CALM_MOOD, 0);
    expect(advanceSpeech(calm, CALM_MOOD, 0).greeting).toBe(false);
    const greeted = advanceSpeech(calm, CALM_MOOD, 1);
    expect(greeted.greeting).toBe(true);
    expect(GREETING_LINES).toContain(greeted.line);
  });
});
