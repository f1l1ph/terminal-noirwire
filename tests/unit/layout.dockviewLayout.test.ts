import { describe, expect, it } from "vitest";
import {
  LAYOUT_STORAGE_KEY,
  LAYOUT_VERSION,
  MAINNET_MAX_TICKET_WIDTH,
  MAINNET_MIN_TICKET_WIDTH,
  PANEL_IDS,
  activePanelIds,
  mainnetPanelSizes,
  clearStoredLayout,
  defaultPanelSizes,
  isValidStoredLayout,
  loadStoredLayout,
  parseStoredLayout,
  saveStoredLayout,
  type DockviewLayoutStorage,
} from "@/lib/layout/dockviewLayout";

function fakeStorage(initial: Record<string, string> = {}): DockviewLayoutStorage & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

const validLayout = {
  grid: { root: {} },
  panels: Object.fromEntries(PANEL_IDS.map((id) => [id, {}])),
};

describe("defaultPanelSizes", () => {
  it("uses the narrow ticket width under the 1800px breakpoint", () => {
    expect(defaultPanelSizes(1440, 900).ticketWidth).toBe(340);
    expect(defaultPanelSizes(1799, 900).ticketWidth).toBe(340);
  });

  it("widens the ticket at or above 1800px", () => {
    expect(defaultPanelSizes(1800, 900).ticketWidth).toBe(380);
    expect(defaultPanelSizes(2200, 900).ticketWidth).toBe(380);
  });

  it("uses the full account height at or above 800px tall", () => {
    expect(defaultPanelSizes(1440, 800).accountHeight).toBe(240);
    expect(defaultPanelSizes(1440, 1200).accountHeight).toBe(240);
  });

  it("shortens the account dock under 800px tall", () => {
    expect(defaultPanelSizes(1440, 799).accountHeight).toBe(200);
    expect(defaultPanelSizes(1440, 600).accountHeight).toBe(200);
  });

  it("always returns a positive markets width and tape height", () => {
    const sizes = defaultPanelSizes(1280, 720);
    expect(sizes.marketsWidth).toBeGreaterThan(0);
    expect(sizes.tapeHeight).toBeGreaterThan(0);
  });
});

describe("isValidStoredLayout", () => {
  it("accepts a well-shaped layout carrying every known panel", () => {
    expect(isValidStoredLayout({ version: LAYOUT_VERSION, layout: validLayout }, PANEL_IDS)).toBe(
      true,
    );
  });

  it("rejects a non-object", () => {
    expect(isValidStoredLayout("nope", PANEL_IDS)).toBe(false);
    expect(isValidStoredLayout(null, PANEL_IDS)).toBe(false);
    expect(isValidStoredLayout([1, 2], PANEL_IDS)).toBe(false);
  });

  it("rejects the wrong version", () => {
    expect(
      isValidStoredLayout({ version: LAYOUT_VERSION + 1, layout: validLayout }, PANEL_IDS),
    ).toBe(false);
  });

  it("rejects a layout missing a panel that exists now", () => {
    const panels: Record<string, unknown> = { ...validLayout.panels };
    delete panels.ticket;
    const broken = { grid: validLayout.grid, panels };
    expect(isValidStoredLayout({ version: LAYOUT_VERSION, layout: broken }, PANEL_IDS)).toBe(false);
  });

  it("rejects a layout with no grid", () => {
    expect(
      isValidStoredLayout(
        { version: LAYOUT_VERSION, layout: { panels: validLayout.panels } },
        PANEL_IDS,
      ),
    ).toBe(false);
  });
});

describe("parseStoredLayout", () => {
  it("returns the inner layout for valid JSON", () => {
    const raw = JSON.stringify({ version: LAYOUT_VERSION, layout: validLayout });
    expect(parseStoredLayout(raw, PANEL_IDS)).toEqual(validLayout);
  });

  it("returns null for malformed JSON", () => {
    expect(parseStoredLayout("{not json", PANEL_IDS)).toBeNull();
  });

  it("returns null for a structurally invalid payload", () => {
    expect(parseStoredLayout(JSON.stringify({ version: LAYOUT_VERSION }), PANEL_IDS)).toBeNull();
  });
});

describe("loadStoredLayout / saveStoredLayout / clearStoredLayout", () => {
  it("round-trips through a fake storage", () => {
    const storage = fakeStorage();
    saveStoredLayout(storage, validLayout);
    expect(loadStoredLayout(storage, PANEL_IDS)).toEqual(validLayout);
    clearStoredLayout(storage);
    expect(loadStoredLayout(storage, PANEL_IDS)).toBeNull();
  });

  it("returns null with no storage (SSR) and is a no-op to save/clear", () => {
    expect(loadStoredLayout(null, PANEL_IDS)).toBeNull();
    expect(() => saveStoredLayout(null, validLayout)).not.toThrow();
    expect(() => clearStoredLayout(null)).not.toThrow();
  });

  it("returns null, and never throws, when the storage itself throws", () => {
    const throwing: DockviewLayoutStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadStoredLayout(throwing, PANEL_IDS)).toBeNull();
    expect(() => saveStoredLayout(throwing, validLayout)).not.toThrow();
    expect(() => clearStoredLayout(throwing)).not.toThrow();
  });

  it("returns null for a missing key", () => {
    expect(loadStoredLayout(fakeStorage(), PANEL_IDS)).toBeNull();
  });

  it("saves under the one versioned storage key", () => {
    const storage = fakeStorage();
    saveStoredLayout(storage, validLayout);
    expect(Object.keys(storage.data)).toEqual([LAYOUT_STORAGE_KEY]);
  });
});

describe("activePanelIds", () => {
  it("keeps every panel on a test build, whatever the tools setting", () => {
    expect(activePanelIds(false, false)).toEqual(PANEL_IDS);
    expect(activePanelIds(false, true)).toEqual(PANEL_IDS);
  });

  it("holds only the chart, ticket and account on mainnet with the tools off", () => {
    expect([...activePanelIds(true, false)].sort()).toEqual(["account", "chart", "ticket"]);
  });

  it("adds the four privacy tool panels, and no markets list, with the tools on", () => {
    const ids = activePanelIds(true, true);
    expect([...ids].sort()).toEqual(
      ["account", "chart", "publicView", "tape", "ticket", "venueTiming", "witness"].sort(),
    );
    expect(ids).not.toContain("markets");
  });
});

describe("a saved layout from before the panel set changed", () => {
  const oldPanels = Object.fromEntries(PANEL_IDS.map((id) => [id, {}]));
  const oldLayout = { grid: { root: {} }, panels: oldPanels };

  it("is not restored on mainnet, so the removed markets and tool panels stay gone", () => {
    const raw = { version: LAYOUT_VERSION, layout: oldLayout };
    expect(isValidStoredLayout(raw, activePanelIds(true, false))).toBe(false);
    expect(isValidStoredLayout(raw, activePanelIds(true, true))).toBe(false);
  });

  it("is rejected by its old version number even when the panels match", () => {
    const raw = { version: LAYOUT_VERSION - 1, layout: oldLayout };
    expect(isValidStoredLayout(raw, PANEL_IDS)).toBe(false);
  });

  it("is restored when the saved panels are exactly the ones in use", () => {
    const panels = Object.fromEntries(activePanelIds(true, false).map((id) => [id, {}]));
    const raw = { version: LAYOUT_VERSION, layout: { grid: { root: {} }, panels } };
    expect(isValidStoredLayout(raw, activePanelIds(true, false))).toBe(true);
  });
});

describe("mainnetPanelSizes", () => {
  it("keeps the ticket column within its allowed range", () => {
    for (const width of [1024, 1440, 1800, 2560]) {
      const { ticketWidth } = mainnetPanelSizes(width, 900);
      expect(ticketWidth).toBeGreaterThanOrEqual(MAINNET_MIN_TICKET_WIDTH);
      expect(ticketWidth).toBeLessThanOrEqual(MAINNET_MAX_TICKET_WIDTH);
    }
  });

  it("leaves the chart about two thirds of the width or more at 1024 and 1440", () => {
    for (const width of [1024, 1440]) {
      const { ticketWidth } = mainnetPanelSizes(width, 900);
      expect((width - ticketWidth) / width).toBeGreaterThanOrEqual(0.62);
    }
  });

  it("shortens the account section on a short window", () => {
    expect(mainnetPanelSizes(1440, 768).accountHeight).toBeLessThan(
      mainnetPanelSizes(1440, 900).accountHeight,
    );
  });
});
