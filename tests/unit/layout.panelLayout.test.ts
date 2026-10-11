import { describe, expect, it } from "vitest";
import {
  COLLAPSED_COLUMN_WIDTH,
  COLLAPSED_ROW_HEIGHT,
  LAYOUT_VERSION,
  MIN_CHART_HEIGHT,
  MIN_CHART_WIDTH,
  MIN_DOCK_HEIGHT,
  MIN_EVIDENCE_WIDTH,
  MIN_MARKETS_WIDTH,
  MIN_TAPE_HEIGHT,
  MIN_TICKET_WIDTH,
  clampColumnWidthsToContainer,
  columnTrackSizes,
  defaultLayout,
  effectiveColumnWidth,
  effectiveDockHeight,
  isDefaultLayout,
  loadPanelLayout,
  moveColumn,
  parseStoredLayout,
  resizeCentreSplit,
  resizeColumnBoundary,
  resizeDock,
  savePanelLayout,
  swapCentre,
  swapColumns,
  toggleCollapsed,
  type LayoutStorage,
  type PanelLayoutState,
} from "@/lib/layout/panelLayout";

function fakeStorage(
  initial: Record<string, string> = {},
): LayoutStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

describe("defaultLayout / defaultSizesForWidth", () => {
  it("uses the narrow breakpoint under 1400px", () => {
    const state = defaultLayout(1200);
    expect(state.sizes).toMatchObject({ markets: 160, evidence: 220, ticket: 292, dock: 180 });
  });

  it("uses the mid breakpoint from 1400 up to 1799px", () => {
    expect(defaultLayout(1400).sizes).toMatchObject({
      markets: 176,
      evidence: 240,
      ticket: 320,
      dock: 200,
    });
    expect(defaultLayout(1799).sizes).toMatchObject({
      markets: 176,
      evidence: 240,
      ticket: 320,
      dock: 200,
    });
  });

  it("uses the wide breakpoint at 1800px and up", () => {
    expect(defaultLayout(1800).sizes).toMatchObject({
      markets: 192,
      evidence: 300,
      ticket: 360,
      dock: 240,
    });
    expect(defaultLayout(2400).sizes).toMatchObject({
      markets: 192,
      evidence: 300,
      ticket: 360,
      dock: 240,
    });
  });

  it("gives the chart about 70% of the centre stack at every breakpoint", () => {
    expect(defaultLayout(1200).sizes.centreSplit).toBeCloseTo(0.7);
    expect(defaultLayout(2000).sizes.centreSplit).toBeCloseTo(0.7);
  });

  it("starts with the documented column and centre order, nothing collapsed", () => {
    const state = defaultLayout(1440);
    expect(state.columnOrder).toEqual(["markets", "centre", "evidence", "ticket"]);
    expect(state.centreOrder).toEqual(["chart", "tape"]);
    expect(Object.values(state.collapsed).every((value) => value === false)).toBe(true);
    expect(state.version).toBe(LAYOUT_VERSION);
  });
});

describe("isDefaultLayout / reset", () => {
  it("is true for a freshly built default layout", () => {
    expect(isDefaultLayout(defaultLayout(1440), 1440)).toBe(true);
  });

  it("is false once a column has been swapped", () => {
    const state = swapColumns(defaultLayout(1440), "markets", "ticket");
    expect(isDefaultLayout(state, 1440)).toBe(false);
  });

  it("is false once a panel has been resized", () => {
    const state = { ...defaultLayout(1440), sizes: { ...defaultLayout(1440).sizes, markets: 200 } };
    expect(isDefaultLayout(state, 1440)).toBe(false);
  });

  it("is false once a panel has been collapsed", () => {
    const state = toggleCollapsed(defaultLayout(1440), "evidence");
    expect(isDefaultLayout(state, 1440)).toBe(false);
  });

  it("is true again after resetting back to the default for that width", () => {
    let state = swapColumns(defaultLayout(1440), "markets", "ticket");
    state = toggleCollapsed(state, "chart");
    expect(isDefaultLayout(state, 1440)).toBe(false);
    state = defaultLayout(1440);
    expect(isDefaultLayout(state, 1440)).toBe(true);
  });
});

describe("swapColumns / moveColumn / swapCentre", () => {
  it("swaps two column slots", () => {
    const state = swapColumns(defaultLayout(1440), "markets", "ticket");
    expect(state.columnOrder).toEqual(["ticket", "centre", "evidence", "markets"]);
  });

  it("is a no-op swapping a slot with itself", () => {
    const base = defaultLayout(1440);
    expect(swapColumns(base, "markets", "markets")).toBe(base);
  });

  it("moveColumn swaps with the right-hand neighbour", () => {
    const state = moveColumn(defaultLayout(1440), "markets", 1);
    expect(state.columnOrder).toEqual(["centre", "markets", "evidence", "ticket"]);
  });

  it("moveColumn swaps with the left-hand neighbour", () => {
    const state = moveColumn(defaultLayout(1440), "ticket", -1);
    expect(state.columnOrder).toEqual(["markets", "centre", "ticket", "evidence"]);
  });

  it("moveColumn is a no-op past either edge", () => {
    const base = defaultLayout(1440);
    expect(moveColumn(base, "markets", -1)).toBe(base);
    expect(moveColumn(base, "ticket", 1)).toBe(base);
  });

  it("swapCentre reverses the chart/tape order", () => {
    const state = swapCentre(defaultLayout(1440));
    expect(state.centreOrder).toEqual(["tape", "chart"]);
    expect(swapCentre(state).centreOrder).toEqual(["chart", "tape"]);
  });
});

describe("resizeColumnBoundary - clamped to minimums", () => {
  const containerWidth = 1600; // plenty of room

  it("never shrinks an explicit column below its minimum (dragging the centre|evidence boundary right shrinks evidence)", () => {
    const state = resizeColumnBoundary(
      defaultLayout(1440),
      "centre",
      "evidence",
      10_000,
      containerWidth,
    );
    expect(state.sizes.evidence).toBe(MIN_EVIDENCE_WIDTH);
  });

  it("never grows an explicit column enough to push the centre column under its minimum width (dragging left grows evidence)", () => {
    const state = resizeColumnBoundary(
      defaultLayout(1440),
      "centre",
      "evidence",
      -10_000,
      containerWidth,
    );
    const otherExplicit = state.sizes.markets + state.sizes.ticket;
    const centreWidth = containerWidth - 24 - otherExplicit - state.sizes.evidence;
    expect(centreWidth).toBeGreaterThanOrEqual(MIN_CHART_WIDTH - 1);
  });

  it("drags a boundary between two explicit columns zero-sum, each still bounded by its own minimum", () => {
    const state = resizeColumnBoundary(
      defaultLayout(1440),
      "evidence",
      "ticket",
      -10_000,
      containerWidth,
    );
    expect(state.sizes.evidence).toBe(MIN_EVIDENCE_WIDTH);
    // The combined width of the two is conserved by a zero-sum drag.
    const base = defaultLayout(1440);
    expect(state.sizes.evidence + state.sizes.ticket).toBe(base.sizes.evidence + base.sizes.ticket);
  });

  it("the markets column floors at its own minimum", () => {
    const state = resizeColumnBoundary(
      defaultLayout(1440),
      "markets",
      "centre",
      -10_000,
      containerWidth,
    );
    expect(state.sizes.markets).toBe(MIN_MARKETS_WIDTH);
  });

  it("a zero delta is a no-op", () => {
    const base = defaultLayout(1440);
    expect(resizeColumnBoundary(base, "markets", "centre", 0, containerWidth)).toBe(base);
  });
});

describe("resizeCentreSplit - clamped to minimums", () => {
  it("never shrinks the chart below its minimum height", () => {
    const state = resizeCentreSplit(defaultLayout(1440), -10_000, 600);
    const usable = 600 - 8;
    expect(state.sizes.centreSplit * usable).toBeCloseTo(MIN_CHART_HEIGHT, 0);
  });

  it("never shrinks the tape below its minimum height", () => {
    const state = resizeCentreSplit(defaultLayout(1440), 10_000, 600);
    const usable = 600 - 8;
    const tapeHeight = (1 - state.sizes.centreSplit) * usable;
    expect(tapeHeight).toBeGreaterThanOrEqual(MIN_TAPE_HEIGHT - 1);
  });

  it("reverses the signed delta when the tape is on top", () => {
    const base = swapCentre(defaultLayout(1440)); // tape, chart
    const grown = resizeCentreSplit(base, 40, 600);
    const shrunk = resizeCentreSplit(base, -40, 600);
    // Dragging down (positive) grows whichever row is physically on top (tape here), so it shrinks chart's share.
    expect(grown.sizes.centreSplit).toBeLessThan(base.sizes.centreSplit);
    expect(shrunk.sizes.centreSplit).toBeGreaterThan(base.sizes.centreSplit);
  });

  it("is a no-op with no measured height", () => {
    const base = defaultLayout(1440);
    expect(resizeCentreSplit(base, 40, 0)).toBe(base);
  });
});

describe("resizeDock - clamped to minimums", () => {
  it("never shrinks the dock below its minimum height", () => {
    const state = resizeDock(defaultLayout(1440), 10_000, 900);
    expect(state.sizes.dock).toBe(MIN_DOCK_HEIGHT);
  });

  it("dragging the splitter up (negative delta) grows the dock", () => {
    const base = defaultLayout(1440);
    const state = resizeDock(base, -20, 900);
    expect(state.sizes.dock).toBe(base.sizes.dock + 20);
  });
});

describe("collapse gives space back", () => {
  it("a collapsed column reports the narrow strip width instead of its stored width", () => {
    const state = toggleCollapsed(defaultLayout(1440), "evidence");
    expect(state.sizes.evidence).toBe(defaultLayout(1440).sizes.evidence); // the stored size is untouched
    expect(effectiveColumnWidth(state, "evidence")).toBe(COLLAPSED_COLUMN_WIDTH);
    expect(COLLAPSED_COLUMN_WIDTH).toBeLessThan(MIN_EVIDENCE_WIDTH); // strictly smaller: the centre column gets the rest
  });

  it("the column grid template reflects the collapsed strip, not the stored width", () => {
    const expanded = defaultLayout(1440);
    const collapsed = toggleCollapsed(expanded, "markets");
    const [expandedTrack] = columnTrackSizes(expanded);
    const [collapsedTrack] = columnTrackSizes(collapsed);
    expect(expandedTrack).toContain(`${expanded.sizes.markets}px`);
    expect(collapsedTrack).toBe(`${COLLAPSED_COLUMN_WIDTH}px`);
  });

  it("the order ticket never collapses the markets/evidence way (it has no collapse entry)", () => {
    const state = defaultLayout(1440);
    expect("ticket" in state.collapsed).toBe(false);
  });

  it("a collapsed account dock reports the title-bar height instead of its stored height", () => {
    const state = toggleCollapsed(defaultLayout(1440), "account");
    expect(effectiveDockHeight(state)).toBe(COLLAPSED_ROW_HEIGHT);
    expect(COLLAPSED_ROW_HEIGHT).toBeLessThan(MIN_DOCK_HEIGHT);
  });

  it("toggling collapse is reversible", () => {
    const base = defaultLayout(1440);
    const toggledTwice = toggleCollapsed(toggleCollapsed(base, "chart"), "chart");
    expect(toggledTwice.collapsed.chart).toBe(false);
  });
});

describe("clampColumnWidthsToContainer", () => {
  it("floors every width at its own minimum regardless of container size", () => {
    const result = clampColumnWidthsToContainer({ markets: 10, evidence: 10, ticket: 10 }, 0);
    expect(result).toEqual({
      markets: MIN_MARKETS_WIDTH,
      evidence: MIN_EVIDENCE_WIDTH,
      ticket: MIN_TICKET_WIDTH,
    });
  });

  it("scales oversized widths down to fit a narrower container without violating any minimum", () => {
    const result = clampColumnWidthsToContainer({ markets: 500, evidence: 500, ticket: 500 }, 1400);
    expect(result.markets).toBeGreaterThanOrEqual(MIN_MARKETS_WIDTH);
    expect(result.evidence).toBeGreaterThanOrEqual(MIN_EVIDENCE_WIDTH);
    expect(result.ticket).toBeGreaterThanOrEqual(MIN_TICKET_WIDTH);
    expect(result.markets + result.evidence + result.ticket).toBeLessThanOrEqual(
      1400 - 24 - MIN_CHART_WIDTH,
    );
  });
});

describe("parseStoredLayout - saved layout restored / invalid falls back", () => {
  it("round-trips a valid, freshly serialised layout", () => {
    const original = swapColumns(defaultLayout(1440), "markets", "evidence");
    const parsed = parseStoredLayout(JSON.stringify(original));
    expect(parsed).toEqual(original);
  });

  it("rejects malformed JSON", () => {
    expect(parseStoredLayout("{not json")).toBeNull();
  });

  it("rejects the wrong version", () => {
    const state = { ...defaultLayout(1440), version: LAYOUT_VERSION + 1 };
    expect(parseStoredLayout(JSON.stringify(state))).toBeNull();
  });

  it("rejects an unknown panel id in columnOrder", () => {
    const state = {
      ...defaultLayout(1440),
      columnOrder: ["markets", "centre", "evidence", "sidebar"],
    };
    expect(parseStoredLayout(JSON.stringify(state))).toBeNull();
  });

  it("rejects a columnOrder missing a required slot (not a permutation)", () => {
    const state = {
      ...defaultLayout(1440),
      columnOrder: ["markets", "markets", "evidence", "ticket"],
    };
    expect(parseStoredLayout(JSON.stringify(state))).toBeNull();
  });

  it("rejects a centreOrder naming the same panel twice", () => {
    const state = { ...defaultLayout(1440), centreOrder: ["chart", "chart"] };
    expect(parseStoredLayout(JSON.stringify(state))).toBeNull();
  });

  it("rejects extra unknown top-level fields", () => {
    const state = { ...defaultLayout(1440), extra: "field" };
    expect(parseStoredLayout(JSON.stringify(state))).toBeNull();
  });

  it("rejects a non-finite size", () => {
    const state: PanelLayoutState = defaultLayout(1440);
    const broken = { ...state, sizes: { ...state.sizes, markets: Number.NaN } };
    expect(parseStoredLayout(JSON.stringify(broken))).toBeNull();
  });
});

describe("loadPanelLayout / savePanelLayout - persistence, including failure paths", () => {
  it("returns the default layout when nothing is stored", () => {
    const storage = fakeStorage();
    expect(loadPanelLayout(storage, 1440, 900)).toEqual(defaultLayout(1440));
  });

  it("restores a previously saved, valid layout (clamped to the current window)", () => {
    const saved = swapColumns(defaultLayout(1440), "markets", "ticket");
    const storage = fakeStorage({ "noirwire-terminal-layout": JSON.stringify(saved) });
    const restored = loadPanelLayout(storage, 1440, 900);
    expect(restored.columnOrder).toEqual(saved.columnOrder);
  });

  it("falls back to the default when the saved value is invalid", () => {
    const storage = fakeStorage({ "noirwire-terminal-layout": '{"version":999}' });
    expect(loadPanelLayout(storage, 1440, 900)).toEqual(defaultLayout(1440));
  });

  it("clamps a saved layout's sizes to a now-narrower window", () => {
    const saved = defaultLayout(2000); // markets 192 / evidence 300 / ticket 360
    const storage = fakeStorage({ "noirwire-terminal-layout": JSON.stringify(saved) });
    // Narrow enough to force the scale-down, but still wide enough that a
    // valid (every-minimum-respected) layout actually exists.
    const restored = loadPanelLayout(storage, 1300, 800);
    expect(restored.sizes.markets).toBeGreaterThanOrEqual(MIN_MARKETS_WIDTH);
    expect(restored.sizes.evidence).toBeGreaterThanOrEqual(MIN_EVIDENCE_WIDTH);
    expect(restored.sizes.ticket).toBeGreaterThanOrEqual(MIN_TICKET_WIDTH);
    expect(restored.sizes.markets + restored.sizes.evidence + restored.sizes.ticket).toBeLessThan(
      saved.sizes.markets + saved.sizes.evidence + saved.sizes.ticket,
    );
  });

  it("storage that throws on read does not break rendering - falls back to the default", () => {
    const storage: LayoutStorage = {
      getItem: () => {
        throw new Error("blocked by a privacy setting");
      },
      setItem: () => {
        throw new Error("blocked by a privacy setting");
      },
    };
    expect(() => loadPanelLayout(storage, 1440, 900)).not.toThrow();
    expect(loadPanelLayout(storage, 1440, 900)).toEqual(defaultLayout(1440));
  });

  it("storage that throws on write does not throw out of savePanelLayout", () => {
    const storage: LayoutStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    expect(() => savePanelLayout(storage, defaultLayout(1440))).not.toThrow();
  });

  it("a null storage (no window) is a safe no-op", () => {
    expect(loadPanelLayout(null, 1440, 900)).toEqual(defaultLayout(1440));
    expect(() => savePanelLayout(null, defaultLayout(1440))).not.toThrow();
  });

  it("persists what was loaded, round-tripping through a real-ish storage object", () => {
    const storage = fakeStorage();
    const state = swapCentre(defaultLayout(1440));
    savePanelLayout(storage, state);
    expect(loadPanelLayout(storage, 1440, 900)).toEqual(state);
  });
});
