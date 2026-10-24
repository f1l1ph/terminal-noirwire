/**
 * The desktop workspace's dockview layout: panel identity, default sizing
 * and saved-layout validation - pure data and pure functions only, so every
 * rule here is unit-testable without a browser or the docking library
 * itself. `src/components/TerminalDockview.tsx` is the only caller that
 * touches `window`/`localStorage` or the `dockview-react` API; it does so
 * through the injectable `DockviewLayoutStorage` below rather than reaching
 * for the globals directly, and treats everything this module exports as
 * opaque data (`unknown`) until it is hand ed to the real
 * `DockviewApi.fromJSON`, which does its own full validation.
 */

export const MARKETS_PANEL_ID = "markets";
export const CHART_PANEL_ID = "chart";
export const TAPE_PANEL_ID = "tape";
export const WITNESS_PANEL_ID = "witness";
export const VENUE_TIMING_PANEL_ID = "venueTiming";
export const PUBLIC_VIEW_PANEL_ID = "publicView";
export const TICKET_PANEL_ID = "ticket";
export const ACCOUNT_PANEL_ID = "account";

export const PANEL_IDS = [
  MARKETS_PANEL_ID,
  CHART_PANEL_ID,
  TAPE_PANEL_ID,
  WITNESS_PANEL_ID,
  VENUE_TIMING_PANEL_ID,
  PUBLIC_VIEW_PANEL_ID,
  TICKET_PANEL_ID,
  ACCOUNT_PANEL_ID,
] as const;

export type PanelId = (typeof PANEL_IDS)[number];

export const PANEL_TITLES: Record<PanelId, string> = {
  [MARKETS_PANEL_ID]: "Markets",
  [CHART_PANEL_ID]: "Chart",
  [TAPE_PANEL_ID]: "Public tape",
  [WITNESS_PANEL_ID]: "Witness rail",
  [VENUE_TIMING_PANEL_ID]: "Venue timing",
  [PUBLIC_VIEW_PANEL_ID]: "Public view",
  [TICKET_PANEL_ID]: "Order ticket",
  [ACCOUNT_PANEL_ID]: "Account",
};

/** The two hard floors from the task: the chart's group and the order ticket's group. Every other boundary only keeps a header visible. */
export const MIN_CHART_WIDTH = 320;
export const MIN_CHART_HEIGHT = 200;
export const MIN_TICKET_WIDTH = 280;

const DEFAULT_MARKETS_WIDTH = 200;
/** The witness/tab-group column has no stated minimum pixel width - a reasonable starting share, freely resizable afterwards. */
const DEFAULT_WITNESS_COLUMN_WIDTH = 280;
const DEFAULT_TICKET_WIDTH = 340;
const WIDE_TICKET_WIDTH = 380;
const WIDE_WIDTH_BREAKPOINT = 1800;
const DEFAULT_ACCOUNT_HEIGHT = 240;
const SHORT_ACCOUNT_HEIGHT = 200;
const SHORT_HEIGHT_BREAKPOINT = 800;

/** The chart's share of the centre column's height at the default layout; the tape gets the rest. */
const DEFAULT_CHART_HEIGHT_FRACTION = 0.7;
/**
 * A representative centre-column content height, used only to pick the
 * tape's initial pixel height before the real container has ever been
 * measured (dockview sizes new panels before layout, not after). A rough
 * starting point - the splitter is freely draggable from the first frame.
 */
const ASSUMED_CENTRE_COLUMN_HEIGHT = 560;

export interface DockviewDefaultSizes {
  marketsWidth: number;
  witnessColumnWidth: number;
  ticketWidth: number;
  accountHeight: number;
  tapeHeight: number;
}

/** Picks the default panel sizes for a window size, per the task's breakpoints (ticket widens at 1800px, the account dock shortens under 800px tall). */
export function defaultPanelSizes(
  windowWidthPx: number,
  windowHeightPx: number,
): DockviewDefaultSizes {
  return {
    marketsWidth: DEFAULT_MARKETS_WIDTH,
    witnessColumnWidth: DEFAULT_WITNESS_COLUMN_WIDTH,
    ticketWidth: windowWidthPx >= WIDE_WIDTH_BREAKPOINT ? WIDE_TICKET_WIDTH : DEFAULT_TICKET_WIDTH,
    accountHeight:
      windowHeightPx < SHORT_HEIGHT_BREAKPOINT ? SHORT_ACCOUNT_HEIGHT : DEFAULT_ACCOUNT_HEIGHT,
    tapeHeight: Math.round(ASSUMED_CENTRE_COLUMN_HEIGHT * (1 - DEFAULT_CHART_HEIGHT_FRACTION)),
  };
}

// ---------------------------------------------------------------------------
// Persistence (storage access is injected, never imported here)
// ---------------------------------------------------------------------------

export const LAYOUT_STORAGE_KEY = "noirwire-terminal-dockview-layout";
export const LAYOUT_VERSION = 1;

/** The minimal storage surface the component needs - matches `window.localStorage`, but lets tests pass a fake (including one that throws). */
export interface DockviewLayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural validation only, on purpose: a dockview `SerializedDockview` is
 * a large, library-owned shape, and re-encoding its full schema here would
 * only drift from whatever the installed version actually accepts. This
 * checks the two things a hand-rolled or stale payload is likely to get
 * wrong - not an object at all, the wrong version, or missing one of the
 * panels this build actually has - and leaves the rest (gridview node
 * shapes, group view state) to the real `DockviewApi.fromJSON`, which throws
 * on a deeper problem; the caller catches that too.
 */
export function isValidStoredLayout(
  raw: unknown,
  requiredPanelIds: readonly string[],
): raw is { version: number; layout: { grid: unknown; panels: Record<string, unknown> } } {
  if (!isPlainObject(raw)) return false;
  if (raw.version !== LAYOUT_VERSION) return false;
  const layout = raw.layout;
  if (!isPlainObject(layout)) return false;
  if (!isPlainObject(layout.grid)) return false;
  const panels = layout.panels;
  if (!isPlainObject(panels)) return false;
  return requiredPanelIds.every((id) => id in panels);
}

/** Parses and validates a stored layout string. Any JSON error, shape mismatch, wrong version, or missing panel falls back to `null` (the caller substitutes the default). */
export function parseStoredLayout(
  raw: string,
  requiredPanelIds: readonly string[],
): unknown | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isValidStoredLayout(json, requiredPanelIds)) return null;
  return json.layout;
}

export function loadStoredLayout(
  storage: DockviewLayoutStorage | null,
  requiredPanelIds: readonly string[],
): unknown | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(LAYOUT_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  return parseStoredLayout(raw, requiredPanelIds);
}

export function saveStoredLayout(storage: DockviewLayoutStorage | null, layout: unknown): void {
  if (!storage) return;
  try {
    storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({ version: LAYOUT_VERSION, layout }));
  } catch {
    // Storage can throw (quota exceeded, private browsing): the layout still
    // works for the rest of this session, it just will not be remembered.
  }
}

export function clearStoredLayout(storage: DockviewLayoutStorage | null): void {
  if (!storage) return;
  try {
    storage.removeItem(LAYOUT_STORAGE_KEY);
  } catch {
    // Same as above - a failed clear is not worth surfacing.
  }
}
