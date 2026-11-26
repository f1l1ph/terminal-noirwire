import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FunThread } from "../../src/components/FunThread";
import type { Mood } from "../../src/lib/trading/positionMood";
import {
  positionCardRule,
  threadOpacity,
  TRIPWIRE_DANGER_COLOR,
  TRIPWIRE_SAFE_COLOR,
  tripwireLine,
  tripwireShadeAlpha,
} from "../../src/lib/trading/tripwire";

const danger: Mood = {
  state: "nearDanger",
  reason: "stopLoss",
  tone: "danger",
  intensity: 0.65,
  progress: 0.8,
  focus: { market: "SOL-PERP", price: "70.40", kind: "stopLoss" },
};

describe("tripwire price line", () => {
  it("draws the target on the followed market in the tone colour with the stop loss title", () => {
    expect(tripwireLine(danger, "SOL-PERP")).toEqual({
      price: 70.4,
      color: TRIPWIRE_DANGER_COLOR,
      lineWidth: 2,
      dashed: false,
      title: "SL",
    });
  });

  it("titles liquidation and take profit, and uses the safe colour for profit", () => {
    const liquidation: Mood = {
      ...danger,
      focus: { market: "SOL-PERP", price: "70.40", kind: "liquidation" },
    };
    expect(tripwireLine(liquidation, "SOL-PERP")?.title).toBe("Liq");
    const profit: Mood = {
      ...danger,
      tone: "profit",
      reason: "takeProfit",
      focus: { market: "SOL-PERP", price: "72.53", kind: "takeProfit" },
    };
    expect(tripwireLine(profit, "SOL-PERP")).toMatchObject({
      title: "TP",
      color: TRIPWIRE_SAFE_COLOR,
    });
  });

  it("titles the target the tone follows, whatever reason the band carries", () => {
    const liquidationInProfitBand: Mood = {
      ...danger,
      state: "nearProfit",
      reason: "takeProfit",
      focus: { market: "SOL-PERP", price: "70.40", kind: "liquidation" },
    };
    expect(tripwireLine(liquidationInProfitBand, "SOL-PERP")?.title).toBe("Liq");
  });

  it("is dashed below 0.25 intensity and thickens with it", () => {
    expect(tripwireLine({ ...danger, intensity: 0.2 }, "SOL-PERP")).toMatchObject({
      dashed: true,
      lineWidth: 1,
    });
    expect(tripwireLine({ ...danger, intensity: 1 }, "SOL-PERP")).toMatchObject({
      dashed: false,
      lineWidth: 3,
    });
  });

  it("draws nothing without a tone, a target price, or on another market", () => {
    expect(tripwireLine(null, "SOL-PERP")).toBeNull();
    expect(tripwireLine({ ...danger, tone: null }, "SOL-PERP")).toBeNull();
    expect(
      tripwireLine(
        { ...danger, focus: { market: "SOL-PERP", price: null, kind: "liquidation" } },
        "SOL-PERP",
      ),
    ).toBeNull();
    expect(tripwireLine({ ...danger, focus: null }, "SOL-PERP")).toBeNull();
    expect(tripwireLine(danger, "ETH-PERP")).toBeNull();
    expect(tripwireLine(danger, undefined)).toBeNull();
  });
});

describe("tripwire shading and thread", () => {
  it("scales the runway and bloom alpha to 40 percent at full intensity", () => {
    expect(tripwireShadeAlpha(1)).toBeCloseTo(0.4);
    expect(tripwireShadeAlpha(0.5)).toBeCloseTo(0.2);
    expect(tripwireShadeAlpha(2)).toBeCloseTo(0.4);
    expect(tripwireShadeAlpha(-1)).toBe(0);
  });

  it("runs the thread opacity from 0.25 to 0.8", () => {
    expect(threadOpacity(0)).toBeCloseTo(0.25);
    expect(threadOpacity(1)).toBeCloseTo(0.8);
  });

  it("draws the thread scaled to progress, hidden from assistive tech and never clickable", () => {
    const html = renderToStaticMarkup(createElement(FunThread, { mood: danger }));
    expect(html).toContain("scaleX(0.8)");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("pointer-events-none");
    expect(
      renderToStaticMarkup(createElement(FunThread, { mood: { ...danger, tone: null } })),
    ).toBe("");
  });
});

describe("position card rule", () => {
  it("marks only the card of the followed market, at the intensity as its alpha", () => {
    const rule = positionCardRule(danger, "SOL-PERP");
    expect(rule).toContain("inset 2px 0 0 0");
    expect(rule).toContain("var(--color-fun-danger) 65%");
    expect(positionCardRule(danger, "ETH-PERP")).toBeUndefined();
    expect(positionCardRule(null, "SOL-PERP")).toBeUndefined();
    expect(positionCardRule({ ...danger, tone: null }, "SOL-PERP")).toBeUndefined();
  });

  it("uses the safe token for profit", () => {
    expect(positionCardRule({ ...danger, tone: "profit" }, "SOL-PERP")).toContain(
      "var(--color-fun-safe)",
    );
  });
});

describe("tripwire colours", () => {
  it("match the Fun tokens", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    expect(css).toContain(`--color-fun-danger: ${TRIPWIRE_DANGER_COLOR}`);
    expect(css).toContain(`--color-fun-safe: ${TRIPWIRE_SAFE_COLOR}`);
  });
});
