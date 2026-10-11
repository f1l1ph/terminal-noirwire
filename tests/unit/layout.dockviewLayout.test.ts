import { describe, expect, it } from "vitest";
import {
  LAYOUT_STORAGE_KEY,
  LAYOUT_VERSION,
  PANEL_IDS,
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
    const { ticket: _ticket, ...rest } = validLayout.panels;
    const broken = { grid: validLayout.grid, panels: rest };
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
