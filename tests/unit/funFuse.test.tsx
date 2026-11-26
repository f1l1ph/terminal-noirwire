import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FunFuse } from "../../src/components/FunFuse";
import type { Mood } from "../../src/lib/trading/positionMood";

const untoned: Mood = {
  state: "calm",
  reason: null,
  tone: null,
  intensity: 0,
  progress: 0,
  focus: null,
};

function render(mood: Mood) {
  return renderToStaticMarkup(createElement(FunFuse, { mood }));
}

describe("fun fuse", () => {
  it("renders nothing without a tone", () => {
    expect(render(untoned)).toBe("");
  });

  it("draws a light layer and a ring that are hidden from assistive tech and never take a click", () => {
    const html = render({ ...untoned, tone: "danger", progress: 0.8, intensity: 0.64 });
    expect(html).toContain('data-testid="fun-fuse-light"');
    expect(html).toContain('data-testid="fun-fuse-ring"');
    expect(html.match(/aria-hidden="true"/g)?.length).toBe(2);
    expect(html.match(/pointer-events-none/g)?.length).toBe(2);
  });

  it("carries the tone and whether the target is reached", () => {
    const html = render({ ...untoned, tone: "profit", progress: 1, intensity: 1 });
    expect(html).toContain('data-tone="profit"');
    expect(html).toContain('data-reached="true"');
    expect(render({ ...untoned, tone: "danger", progress: 0.5, intensity: 0.25 })).toContain(
      'data-reached="false"',
    );
  });
});
