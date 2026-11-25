import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { STOP_ANSWERS } from "@/lib/analytics";
import { STOP_ASK_AFTER_MS } from "@/lib/setupFunnel";
import { STOP_CHOICES, StopReasonAsk } from "@/components/StopReasonAsk";

describe("StopReasonAsk", () => {
  it("offers every listed answer except dismissed as a choice, once each", () => {
    const offered = STOP_CHOICES.map((choice) => choice.answer);
    expect(new Set(offered).size).toBe(offered.length);
    expect([...offered, "dismissed"].sort()).toEqual([...STOP_ANSWERS].sort());
  });

  it("shows nothing until the wait has passed", () => {
    expect(renderToStaticMarkup(<StopReasonAsk active />)).toBe("");
    expect(renderToStaticMarkup(<StopReasonAsk active={false} />)).toBe("");
  });

  it("waits 45 seconds", () => {
    expect(STOP_ASK_AFTER_MS).toBe(45_000);
  });
});
