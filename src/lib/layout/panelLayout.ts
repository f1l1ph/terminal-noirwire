import { z } from "zod";

/**
 * The desktop workspace's movable/resizable/collapsible panel layout: pure
 * data and pure transforms only, so every rule here (defaults, minimums,
 * swap, clamp, persistence shape) is unit-testable without a browser.
 * `src/components/hooks/usePanelLayout.ts` is the only caller that touches
 * `window`/`localStorage`, and it does so through the injectable
 * `LayoutStorage` below rather than reaching for the globals directly.
 */

export const LAYOUT_STORAGE_KEY = "noirwire-terminal-layout";
export const LAYOUT_VERSION = 1;

/** The four swappable column positions. "centre" holds the Chart/Public tape stack. */
export const COLUMN_SLOTS = ["markets", "centre", "evidence", "ticket"] as const;
export type ColumnSlotId = (typeof COLUMN_SLOTS)[number];

/** The two swappable rows inside the centre column. */
export const CENTRE_PANELS = ["chart", "tape"] as const;
export type CentrePanelId = (typeof CENTRE_PANELS)[number];

/** Every panel that can collapse to its title bar. The order ticket cannot. */
export const COLLAPSIBLE_PANELS = ["markets", "chart", "tape", "evidence", "account"] as const;
export type CollapsiblePanelId = (typeof COLLAPSIBLE_PANELS)[number];

export interface PanelSizes {
  /** Markets column width, px. */
  markets: number;
  /** Evidence column width, px. */
  evidence: number;
  /** Order ticket column width, px. */
  ticket: number;
  /** Account dock height, px. */
  dock: number;
  /** Chart's share of the centre stack's height, 0..1 (the rest goes to the tape). */
  centreSplit: number;
}

export interface PanelCollapsedState {
  markets: boolean;
  chart: boolean;
  tape: boolean;
  evidence: boolean;
  account: boolean;
}

export interface PanelLayoutState {
  version: number;
  columnOrder: ColumnSlotId[];
  centreOrder: [CentrePanelId, CentrePanelId];
  sizes: PanelSizes;
  collapsed: PanelCollapsedState;
}

// ---------------------------------------------------------------------------
// Minimums (the task's hard floors) and fixed strip sizes for a collapsed panel.
// ---------------------------------------------------------------------------

export const MIN_MARKETS_WIDTH = 152;
export const MIN_CHART_WIDTH = 480;
export const MIN_CHART_HEIGHT = 260;
export const MIN_TAPE_HEIGHT = 100;
export const MIN_EVIDENCE_WIDTH = 220;
export const MIN_TICKET_WIDTH = 288;
export const MIN_DOCK_HEIGHT = 90;

/** A collapsed column (Markets/Evidence) shrinks to this labelled strip. */
export const COLLAPSED_COLUMN_WIDTH = 36;
/** A collapsed row (Chart/Public tape/Account) shrinks to this title-bar height. */
export const COLLAPSED_ROW_HEIGHT = 32;

/** The visual gap between panels and between a panel and its splitter, px - matches the grid's own splitter track width. */
export const SPLITTER_SIZE = 8;

export const COLUMN_MIN_WIDTH: Record<Exclude<ColumnSlotId, "centre">, number> = {
  markets: MIN_MARKETS_WIDTH,
  evidence: MIN_EVIDENCE_WIDTH,
  ticket: MIN_TICKET_WIDTH,
};

export const CENTRE_MIN_HEIGHT: Record<CentrePanelId, number> = {
  chart: MIN_CHART_HEIGHT,
  tape: MIN_TAPE_HEIGHT,
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

interface BreakpointSizes {
  markets: number;
  evidence: number;
  ticket: number;
  dock: number;
}

const BREAKPOINT_NARROW: BreakpointSizes = { markets: 160, evidence: 220, ticket: 292, dock: 180 };
const BREAKPOINT_MID: BreakpointSizes = { markets: 176, evidence: 240, ticket: 320, dock: 200 };
const BREAKPOINT_WIDE: BreakpointSizes = { markets: 192, evidence: 300, ticket: 360, dock: 240 };

/** Chart gets about 70% of the centre stack's height, the tape the rest, at every breakpoint. */
export const DEFAULT_CENTRE_SPLIT = 0.7;

export function defaultSizesForWidth(windowWidth: number): BreakpointSizes {
  if (windowWidth < 1400) return BREAKPOINT_NARROW;
  if (windowWidth < 1800) return BREAKPOINT_MID;
  return BREAKPOINT_WIDE;
}

export function defaultCollapsed(): PanelCollapsedState {
  return { markets: false, chart: false, tape: false, evidence: false, account: false };
}

export function defaultLayout(windowWidth: number): PanelLayoutState {
  const breakpoint = defaultSizesForWidth(windowWidth);
  return {
    version: LAYOUT_VERSION,
    columnOrder: ["markets", "centre", "evidence", "ticket"],
    centreOrder: ["chart", "tape"],
    sizes: { ...breakpoint, centreSplit: DEFAULT_CENTRE_SPLIT },
    collapsed: defaultCollapsed(),
  };
}

export function isDefaultLayout(state: PanelLayoutState, windowWidth: number): boolean {
  const base = defaultLayout(windowWidth);
  return (
    arraysEqual(state.columnOrder, base.columnOrder) &&
    arraysEqual(state.centreOrder, base.centreOrder) &&
    state.sizes.markets === base.sizes.markets &&
    state.sizes.evidence === base.sizes.evidence &&
    state.sizes.ticket === base.sizes.ticket &&
    state.sizes.dock === base.sizes.dock &&
    state.sizes.centreSplit === base.sizes.centreSplit &&
    !state.collapsed.markets &&
    !state.collapsed.chart &&
    !state.collapsed.tape &&
    !state.collapsed.evidence &&
    !state.collapsed.account
  );
}

function arraysEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// ---------------------------------------------------------------------------
// Effective (render-time) sizes - what a collapsed panel actually measures.
// ---------------------------------------------------------------------------

export function effectiveColumnWidth(
  state: PanelLayoutState,
  slot: Exclude<ColumnSlotId, "centre">,
): number {
  if (slot !== "ticket" && state.collapsed[slot]) return COLLAPSED_COLUMN_WIDTH;
  return state.sizes[slot];
}

export function effectiveRowShare(state: PanelLayoutState, panel: CentrePanelId): number {
  return panel === "chart" ? state.sizes.centreSplit : 1 - state.sizes.centreSplit;
}

export function effectiveDockHeight(state: PanelLayoutState): number {
  return state.collapsed.account
    ? COLLAPSED_ROW_HEIGHT
    : Math.max(MIN_DOCK_HEIGHT, state.sizes.dock);
}

/**
 * CSS grid track sizes for the four column slots, in `columnOrder`'s
 * position order (left to right) - a collapsed column is a fixed strip, an
 * expanded one a `minmax(min, storedWidth)` so a too-small stored value
 * (an old save, a narrowed window) is still never rendered under its floor.
 * The centre column never collapses as a column and always keeps the rest
 * of the row via `1fr`.
 */
export function columnTrackSizes(state: PanelLayoutState): string[] {
  return state.columnOrder.map((slot) => {
    if (slot === "centre") return `minmax(${MIN_CHART_WIDTH}px, 1fr)`;
    if (slot !== "ticket" && state.collapsed[slot]) return `${COLLAPSED_COLUMN_WIDTH}px`;
    return `minmax(${COLUMN_MIN_WIDTH[slot]}px, ${state.sizes[slot]}px)`;
  });
}

/**
 * CSS grid track sizes for the two centre-stack rows, in `centreOrder`'s
 * position order (top to bottom). A collapsed row is a fixed title-bar
 * height; an expanded row is `minmax(min, shareFr)` so the one row left
 * un-collapsed always receives whatever height the collapsed row gave up -
 * it is the only flexible track left in the template.
 */
export function centreRowSizes(state: PanelLayoutState): string[] {
  return state.centreOrder.map((id) => {
    if (state.collapsed[id]) return `${COLLAPSED_ROW_HEIGHT}px`;
    return `minmax(${CENTRE_MIN_HEIGHT[id]}px, ${effectiveRowShare(state, id)}fr)`;
  });
}

// ---------------------------------------------------------------------------
// Clamp helpers
// ---------------------------------------------------------------------------

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Clamps the three explicit column widths so markets+evidence+ticket never
 * leaves less than `MIN_CHART_WIDTH` for the centre column, given a known
 * container width (three splitter tracks between the four columns). Scales
 * all three down proportionally rather than picking one to shrink, so no
 * single edit (e.g. a narrower saved window) arbitrarily favours one panel.
 */
export function clampColumnWidthsToContainer(
  sizes: Pick<PanelSizes, "markets" | "evidence" | "ticket">,
  containerWidthPx: number,
): Pick<PanelSizes, "markets" | "evidence" | "ticket"> {
  let markets = Math.max(sizes.markets, MIN_MARKETS_WIDTH);
  let evidence = Math.max(sizes.evidence, MIN_EVIDENCE_WIDTH);
  let ticket = Math.max(sizes.ticket, MIN_TICKET_WIDTH);
  const maxExplicitSum = containerWidthPx - SPLITTER_SIZE * 3 - MIN_CHART_WIDTH;
  const minExplicitSum = MIN_MARKETS_WIDTH + MIN_EVIDENCE_WIDTH + MIN_TICKET_WIDTH;
  const total = markets + evidence + ticket;
  if (containerWidthPx > 0 && total > maxExplicitSum && maxExplicitSum >= minExplicitSum) {
    const scale = maxExplicitSum / total;
    markets = Math.max(MIN_MARKETS_WIDTH, Math.floor(markets * scale));
    evidence = Math.max(MIN_EVIDENCE_WIDTH, Math.floor(evidence * scale));
    ticket = Math.max(MIN_TICKET_WIDTH, Math.floor(ticket * scale));
  }
  return { markets, evidence, ticket };
}

export function clampDockHeight(dock: number, windowHeightPx: number): number {
  const minTopArea = MIN_CHART_HEIGHT + MIN_TAPE_HEIGHT + SPLITTER_SIZE + 160;
  const maxDock = Math.max(MIN_DOCK_HEIGHT, windowHeightPx - minTopArea);
  return clamp(dock, MIN_DOCK_HEIGHT, maxDock);
}

export function clampCentreSplit(fraction: number): number {
  return clamp(fraction, 0.05, 0.95);
}

/** Validates a freshly-loaded (or freshly-resized) layout against the current window: every stored minimum and the window's own bounds. */
export function clampToWindow(
  state: PanelLayoutState,
  windowWidthPx: number,
  windowHeightPx: number,
): PanelLayoutState {
  const { markets, evidence, ticket } = clampColumnWidthsToContainer(state.sizes, windowWidthPx);
  return {
    ...state,
    sizes: {
      markets,
      evidence,
      ticket,
      dock: clampDockHeight(state.sizes.dock, windowHeightPx),
      centreSplit: clampCentreSplit(state.sizes.centreSplit),
    },
  };
}

// ---------------------------------------------------------------------------
// Transforms - every one returns a new state, never mutates its input.
// ---------------------------------------------------------------------------

export function swapColumns(
  state: PanelLayoutState,
  a: ColumnSlotId,
  b: ColumnSlotId,
): PanelLayoutState {
  if (a === b) return state;
  const order = [...state.columnOrder];
  const indexA = order.indexOf(a);
  const indexB = order.indexOf(b);
  if (indexA === -1 || indexB === -1) return state;
  [order[indexA], order[indexB]] = [order[indexB], order[indexA]];
  return { ...state, columnOrder: order };
}

/** The keyboard equivalent of a drag: swaps a column slot with its left (-1) or right (+1) neighbour. A no-op at either edge. */
export function moveColumn(
  state: PanelLayoutState,
  slot: ColumnSlotId,
  direction: -1 | 1,
): PanelLayoutState {
  const index = state.columnOrder.indexOf(slot);
  const neighbourIndex = index + direction;
  if (index === -1 || neighbourIndex < 0 || neighbourIndex >= state.columnOrder.length)
    return state;
  return swapColumns(state, slot, state.columnOrder[neighbourIndex]);
}

export function swapCentre(state: PanelLayoutState): PanelLayoutState {
  return { ...state, centreOrder: [state.centreOrder[1], state.centreOrder[0]] };
}

export function toggleCollapsed(
  state: PanelLayoutState,
  panel: CollapsiblePanelId,
): PanelLayoutState {
  return { ...state, collapsed: { ...state.collapsed, [panel]: !state.collapsed[panel] } };
}

function otherColumnWidthsSum(sizes: PanelSizes, except: Exclude<ColumnSlotId, "centre">): number {
  return (Object.keys(COLUMN_MIN_WIDTH) as Exclude<ColumnSlotId, "centre">[])
    .filter((id) => id !== except)
    .reduce((sum, id) => sum + sizes[id], 0);
}

/**
 * Drags the boundary between two adjacent column slots by `deltaPx` (screen
 * right/down is positive). When one side is the centre column (no stored
 * width of its own - it is always "the rest"), only the explicit side's
 * width changes, clamped so the centre column never drops under
 * `MIN_CHART_WIDTH`. When both sides are explicit columns, the drag is
 * zero-sum between them, each still bounded by its own minimum.
 */
export function resizeColumnBoundary(
  state: PanelLayoutState,
  leftSlot: ColumnSlotId,
  rightSlot: ColumnSlotId,
  deltaPx: number,
  containerWidthPx: number,
): PanelLayoutState {
  if (deltaPx === 0) return state;
  const sizes = { ...state.sizes };
  const maxExplicitSum = containerWidthPx - SPLITTER_SIZE * 3 - MIN_CHART_WIDTH;

  if (leftSlot !== "centre" && rightSlot !== "centre") {
    const left0 = sizes[leftSlot];
    const right0 = sizes[rightSlot];
    const newLeft = clamp(
      left0 + deltaPx,
      COLUMN_MIN_WIDTH[leftSlot],
      left0 + right0 - COLUMN_MIN_WIDTH[rightSlot],
    );
    sizes[leftSlot] = newLeft;
    sizes[rightSlot] = left0 + right0 - newLeft;
    return { ...state, sizes };
  }

  if (leftSlot !== "centre") {
    const maxForLeft =
      containerWidthPx > 0 ? maxExplicitSum - otherColumnWidthsSum(sizes, leftSlot) : Infinity;
    sizes[leftSlot] = clamp(
      sizes[leftSlot] + deltaPx,
      COLUMN_MIN_WIDTH[leftSlot],
      Math.max(maxForLeft, COLUMN_MIN_WIDTH[leftSlot]),
    );
    return { ...state, sizes };
  }

  if (rightSlot !== "centre") {
    const maxForRight =
      containerWidthPx > 0 ? maxExplicitSum - otherColumnWidthsSum(sizes, rightSlot) : Infinity;
    sizes[rightSlot] = clamp(
      sizes[rightSlot] - deltaPx,
      COLUMN_MIN_WIDTH[rightSlot],
      Math.max(maxForRight, COLUMN_MIN_WIDTH[rightSlot]),
    );
    return { ...state, sizes };
  }

  return state;
}

/** Drags the splitter between the chart and the public tape. `deltaPx` is the pointer's vertical movement; `totalHeightPx` is the centre stack's measured content height (both rows plus the splitter). */
export function resizeCentreSplit(
  state: PanelLayoutState,
  deltaPx: number,
  totalHeightPx: number,
): PanelLayoutState {
  if (deltaPx === 0 || totalHeightPx <= 0) return state;
  const usable = totalHeightPx - SPLITTER_SIZE;
  if (usable <= 0) return state;
  const chartTopIsFirst = state.centreOrder[0] === "chart";
  const chartPx0 = state.sizes.centreSplit * usable;
  // Dragging the splitter down grows whichever row is on top.
  const signedDelta = chartTopIsFirst ? deltaPx : -deltaPx;
  const newChartPx = clamp(chartPx0 + signedDelta, MIN_CHART_HEIGHT, usable - MIN_TAPE_HEIGHT);
  const fraction = clampCentreSplit(newChartPx / usable);
  return { ...state, sizes: { ...state.sizes, centreSplit: fraction } };
}

export function resizeDock(
  state: PanelLayoutState,
  deltaPx: number,
  windowHeightPx: number,
): PanelLayoutState {
  if (deltaPx === 0) return state;
  // The splitter sits above the dock: dragging it up grows the dock.
  const next = clampDockHeight(state.sizes.dock - deltaPx, windowHeightPx);
  return { ...state, sizes: { ...state.sizes, dock: next } };
}

// ---------------------------------------------------------------------------
// Validation + persistence (storage access is injected, never imported here)
// ---------------------------------------------------------------------------

const columnSlotSchema = z.enum(COLUMN_SLOTS);
const centrePanelSchema = z.enum(CENTRE_PANELS);

const panelLayoutSchema = z
  .object({
    version: z.literal(LAYOUT_VERSION),
    columnOrder: z
      .array(columnSlotSchema)
      .length(4)
      .refine(
        (order) => new Set(order).size === 4,
        "columnOrder must be a permutation of all four slots",
      ),
    centreOrder: z
      .tuple([centrePanelSchema, centrePanelSchema])
      .refine(([a, b]) => a !== b, "centreOrder must contain both panels"),
    sizes: z.object({
      markets: z.number().finite(),
      evidence: z.number().finite(),
      ticket: z.number().finite(),
      dock: z.number().finite(),
      centreSplit: z.number().finite(),
    }),
    collapsed: z.object({
      markets: z.boolean(),
      chart: z.boolean(),
      tape: z.boolean(),
      evidence: z.boolean(),
      account: z.boolean(),
    }),
  })
  .strict();

/** Parses and validates a stored layout string. Any shape mismatch, unknown panel id, or wrong version falls back to `null` (the caller substitutes the default). */
export function parseStoredLayout(raw: string): PanelLayoutState | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = panelLayoutSchema.safeParse(json);
  if (!result.success) return null;
  return result.data as PanelLayoutState;
}

/** The minimal storage surface the hook needs - matches `window.localStorage`, but lets tests pass a fake (including one that throws). */
export interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadPanelLayout(
  storage: LayoutStorage | null,
  windowWidthPx: number,
  windowHeightPx: number,
): PanelLayoutState {
  if (!storage) return defaultLayout(windowWidthPx);
  let raw: string | null;
  try {
    raw = storage.getItem(LAYOUT_STORAGE_KEY);
  } catch {
    return defaultLayout(windowWidthPx);
  }
  if (!raw) return defaultLayout(windowWidthPx);
  const parsed = parseStoredLayout(raw);
  if (!parsed) return defaultLayout(windowWidthPx);
  return clampToWindow(parsed, windowWidthPx, windowHeightPx);
}

export function savePanelLayout(storage: LayoutStorage | null, state: PanelLayoutState): void {
  if (!storage) return;
  try {
    storage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage can throw (quota exceeded, private browsing): the layout still
    // works for the rest of this session, it just will not be remembered.
  }
}
