"use client";

import "dockview-react/dist/styles/dockview.css";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  DockviewReact,
  DockviewDefaultTab,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
  type DockviewTheme,
  type SerializedDockview,
  type SerializedGridObject,
} from "dockview-react";
import { useTerminalPanelData } from "@/components/panels/TerminalPanelContext";
import { MarketSwitcher } from "@/components/MarketSwitcher";
import { MarketHeader } from "@/components/MarketHeader";
import { MarketChart } from "@/components/MarketChart";
import { PublicTape } from "@/components/PublicTape";
import { VenuePulse } from "@/components/VenuePulse";
import { PublicView } from "@/components/PublicView";
import { priceDecimalsOf, sizeDecimalsOf } from "@/lib/market-data/precision";
import { usePrivacyTools } from "@/components/hooks/usePrivacyTools";
import { isMainnetBuild } from "@/lib/network";
import {
  ACCOUNT_PANEL_ID,
  CHART_PANEL_ID,
  MAINNET_MAX_TICKET_WIDTH,
  MAINNET_MIN_TICKET_WIDTH,
  MAINNET_PANEL_TITLES,
  MAINNET_TOOLS_PANEL_IDS,
  MARKETS_PANEL_ID,
  MIN_CHART_HEIGHT,
  MIN_CHART_WIDTH,
  MIN_TICKET_WIDTH,
  PANEL_TITLES,
  PUBLIC_VIEW_PANEL_ID,
  TAPE_PANEL_ID,
  TICKET_PANEL_ID,
  VENUE_TIMING_PANEL_ID,
  WITNESS_PANEL_ID,
  activePanelIds,
  clearStoredLayout,
  defaultPanelSizes,
  loadStoredLayout,
  mainnetPanelSizes,
  saveStoredLayout,
  type DockviewDefaultSizes,
  type DockviewLayoutStorage,
} from "@/lib/layout/dockviewLayout";

/** Themed entirely through dockview's own CSS variables (globals.css, `.dv-theme-noirwire`) so it reads as part of the terminal, not a bundled widget. */
const noirwireDockviewTheme: DockviewTheme = {
  name: "noirwire",
  className: "dv-theme-noirwire",
  colorScheme: "dark",
  tabGroupIndicator: "none",
};

/** The real-money workspace sets its panels apart by space instead of by lines. */
const mainnetDockviewTheme: DockviewTheme = {
  ...noirwireDockviewTheme,
  className: "dv-theme-noirwire dv-theme-calm",
  gap: 8,
};

const SAVE_DEBOUNCE_MS: number = 400;

function browserLayoutStorage(): DockviewLayoutStorage | null {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

/**
 * The only way to maximize/restore a group: double-clicking its tab. No
 * built-in header button is added (a bare tab strip, nothing to accidentally
 * click), and dockview ships no default double-click behaviour itself, so
 * this wraps the stock tab with one handler. `hideClose` is the simple
 * choice for "a closed panel must stay recoverable" - there is no close
 * button anywhere, so there is nothing to recover from.
 */
function MaximizableTab(props: IDockviewPanelHeaderProps) {
  function handleDoubleClick() {
    if (props.api.isMaximized()) props.api.exitMaximized();
    else props.api.maximize();
  }
  return <DockviewDefaultTab {...props} hideClose onDoubleClick={handleDoubleClick} />;
}

function MarketsPanel() {
  const data = useTerminalPanelData();
  return (
    <MarketSwitcher
      markets={data.markets}
      selectedId={data.selectedMarketId}
      selectedMark={data.mark}
      onSelect={data.onSelectMarket}
      now={data.now}
    />
  );
}

function ChartPanel() {
  const data = useTerminalPanelData();
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-1 p-1">
      {!isMainnetBuild() && <MarketHeader marketId={data.market?.id} />}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <MarketChart
          market={data.market}
          candles={data.candles}
          mark={data.mark}
          publicFills={data.tape}
          ownSequences={data.ownSequences}
          loading={data.candlesLoading}
          markStale={data.markStale}
          limitLine={data.limitLine}
        />
      </div>
    </div>
  );
}

function TapePanel() {
  const data = useTerminalPanelData();
  return (
    <PublicTape
      fills={data.tape}
      priceDecimals={data.market ? priceDecimalsOf(data.market) : 2}
      sizeDecimals={data.market ? sizeDecimalsOf(data.market) : 4}
      ownSequences={data.ownSequences}
      bordered={false}
    />
  );
}

function TicketPanel() {
  const data = useTerminalPanelData();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [moreBelow, setMoreBelow] = useState(false);
  const measure = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    setMoreBelow(element.scrollHeight - element.scrollTop - element.clientHeight > 4);
  }, []);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [measure]);
  return (
    <div className="relative h-full min-h-0 w-full">
      <div ref={scrollRef} onScroll={measure} className="h-full min-h-0 w-full overflow-y-auto">
        <div>{data.orderEntry}</div>
      </div>
      {moreBelow && (
        <div
          aria-hidden="true"
          className="from-surface pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t to-transparent"
        />
      )}
    </div>
  );
}

function AccountPanel() {
  const data = useTerminalPanelData();
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="shrink-0 px-3 pt-3 empty:hidden">{data.orderNotice}</div>
      {data.accountDock}
    </div>
  );
}

function WitnessPanel() {
  const data = useTerminalPanelData();
  return <div className="h-full min-h-0 w-full overflow-y-auto p-2">{data.witnessRail}</div>;
}

function VenueTimingPanel() {
  const data = useTerminalPanelData();
  return (
    <div className="h-full min-h-0 w-full overflow-y-auto p-2">
      <VenuePulse
        stats={data.stats}
        now={data.now}
        network={data.network}
        clientDurationMs={data.clientDurationMs}
        bordered={false}
      />
    </div>
  );
}

function PublicViewPanel() {
  const data = useTerminalPanelData();
  return (
    <div className="h-full min-h-0 w-full overflow-y-auto p-2">
      <PublicView
        market={data.selectedMarketId}
        checkPrivacy={data.checkPrivacy}
        bordered={false}
      />
    </div>
  );
}

/**
 * A stable map, defined once: every panel component reads the one shared
 * context rather than dockview's own per-panel `params`, so re-registering
 * this object (which `dockview-react` does harmlessly on every options
 * change anyway) never matters and a panel's own React state is never a
 * function of anything dockview passes it.
 */
const PANEL_COMPONENTS = {
  [MARKETS_PANEL_ID]: MarketsPanel,
  [CHART_PANEL_ID]: ChartPanel,
  [TAPE_PANEL_ID]: TapePanel,
  [TICKET_PANEL_ID]: TicketPanel,
  [ACCOUNT_PANEL_ID]: AccountPanel,
  [WITNESS_PANEL_ID]: WitnessPanel,
  [VENUE_TIMING_PANEL_ID]: VenueTimingPanel,
  [PUBLIC_VIEW_PANEL_ID]: PublicViewPanel,
};

/**
 * The real per-group state (`GroupPanelViewState`, carrying `views: string[]`
 * among other fields) is not part of dockview-react's public type exports;
 * this names only the one field read here; the value is still the library's
 * own object, so a direct property read of `views` against this interface's
 * assignable subset of it needs no further cast.
 */
interface LeafPanelState {
  views: string[];
}
type GridNode = SerializedGridObject<LeafPanelState>;

function subtreeHasPanel(node: GridNode, panelId: string): boolean {
  if (node.type === "leaf") return (node.data as LeafPanelState).views.includes(panelId);
  return (node.data as GridNode[]).some((child) => subtreeHasPanel(child, panelId));
}

/** Sets the `size` of whichever of `children` contains `panelId` anywhere in its own subtree - a branch node (e.g. a whole column) when that panel shares it with others, a leaf when it does not. */
function sizeChildContaining(
  children: GridNode[],
  panelId: string,
  size: number,
): GridNode | undefined {
  const child = children.find((candidate) => subtreeHasPanel(candidate, panelId));
  if (child) child.size = size;
  return child;
}

/**
 * Pins the intended default pixel sizes directly in the serialized tree,
 * rather than issuing a `setSize` per panel on the live api: each column
 * here is a BRANCH (its panel's own group nests inside a further vertical
 * split, e.g. the witness column also holds the venue timing / public view
 * tab group beneath it), and a panel's own `group.api.setSize` only ever
 * resizes its immediate slot - which, for a nested branch, is a share of
 * its column's height, never the column's width. Issuing one `setSize` per
 * column on the live splitview also compounds: each call redistributes the
 * OTHERS in that same splitview to make room, so by the last call the
 * earlier ones have already drifted. Editing the plain, already-serialized
 * tree and loading it back in one `fromJSON` sets every size at once, with
 * no interactive-resize semantics to account for.
 */
function applyDefaultSizes(layout: SerializedDockview, sizes: DockviewDefaultSizes): void {
  const root = layout.grid.root;
  if (root.type !== "branch") return;
  const rootChildren = root.data as GridNode[];
  sizeChildContaining(rootChildren, ACCOUNT_PANEL_ID, sizes.accountHeight);

  const topRow = rootChildren.find((child) => subtreeHasPanel(child, MARKETS_PANEL_ID));
  if (!topRow || topRow.type !== "branch") return;
  const topRowChildren = topRow.data as GridNode[];
  sizeChildContaining(topRowChildren, MARKETS_PANEL_ID, sizes.marketsWidth);
  sizeChildContaining(topRowChildren, WITNESS_PANEL_ID, sizes.witnessColumnWidth);
  sizeChildContaining(topRowChildren, TICKET_PANEL_ID, sizes.ticketWidth);

  const centreStack = topRowChildren.find((child) => subtreeHasPanel(child, CHART_PANEL_ID));
  if (centreStack && centreStack.type === "branch") {
    sizeChildContaining(centreStack.data as GridNode[], TAPE_PANEL_ID, sizes.tapeHeight);
  }
}

/**
 * Builds the default arrangement from scratch: Markets at the left; a
 * centre column of Chart over Public tape; a column of Witness rail over a
 * tab group holding Venue timing and Public view; the Order ticket on the
 * right; Account spanning the full width at the bottom. Every panel renders
 * "always" (see the CRITICAL rule in the module doc below) so a layout
 * change never remounts one.
 */
function buildDefaultLayout(api: DockviewApi, windowWidthPx: number, windowHeightPx: number): void {
  const sizes = defaultPanelSizes(windowWidthPx, windowHeightPx);

  // Order matters here in a way that has nothing to do with the visual
  // result: splitting "below"/"right" of a reference panel splits THAT
  // PANEL'S OWN CELL, wherever it currently sits in the tree - including
  // the panel being the entire grid so far, which would split the whole
  // grid, not just a future column. Every reference panel below is already
  // in its final row position (and not yet further subdivided) before
  // anything is nested under or beside it, so each split lands exactly
  // where the column diagram in the task describes it, not one level up
  // or down from that.
  api.addPanel({
    id: CHART_PANEL_ID,
    component: CHART_PANEL_ID,
    title: PANEL_TITLES[CHART_PANEL_ID],
    renderer: "always",
    minimumWidth: MIN_CHART_WIDTH,
    minimumHeight: MIN_CHART_HEIGHT,
  });
  api.addPanel({
    id: MARKETS_PANEL_ID,
    component: MARKETS_PANEL_ID,
    title: PANEL_TITLES[MARKETS_PANEL_ID],
    renderer: "always",
    position: { referencePanel: CHART_PANEL_ID, direction: "left" },
    initialWidth: sizes.marketsWidth,
  });
  api.addPanel({
    id: WITNESS_PANEL_ID,
    component: WITNESS_PANEL_ID,
    title: PANEL_TITLES[WITNESS_PANEL_ID],
    renderer: "always",
    position: { referencePanel: CHART_PANEL_ID, direction: "right" },
    initialWidth: sizes.witnessColumnWidth,
  });
  api.addPanel({
    id: TICKET_PANEL_ID,
    component: TICKET_PANEL_ID,
    title: PANEL_TITLES[TICKET_PANEL_ID],
    renderer: "always",
    position: { referencePanel: WITNESS_PANEL_ID, direction: "right" },
    initialWidth: sizes.ticketWidth,
    minimumWidth: MIN_TICKET_WIDTH,
  });
  // Only now does anything nest BELOW an existing column - Chart and
  // Witness are still plain leaves in the row, so each split replaces just
  // that one leaf with a column, leaving Markets/Witness-or-Ticket/Ticket
  // alone.
  api.addPanel({
    id: TAPE_PANEL_ID,
    component: TAPE_PANEL_ID,
    title: PANEL_TITLES[TAPE_PANEL_ID],
    renderer: "always",
    position: { referencePanel: CHART_PANEL_ID, direction: "below" },
    initialHeight: sizes.tapeHeight,
  });
  api.addPanel({
    id: PUBLIC_VIEW_PANEL_ID,
    component: PUBLIC_VIEW_PANEL_ID,
    title: PANEL_TITLES[PUBLIC_VIEW_PANEL_ID],
    renderer: "always",
    position: { referencePanel: WITNESS_PANEL_ID, direction: "below" },
  });
  api.addPanel({
    id: VENUE_TIMING_PANEL_ID,
    component: VENUE_TIMING_PANEL_ID,
    title: PANEL_TITLES[VENUE_TIMING_PANEL_ID],
    renderer: "always",
    position: { referencePanel: PUBLIC_VIEW_PANEL_ID, direction: "within" },
    inactive: true,
  });
  api.addPanel({
    id: ACCOUNT_PANEL_ID,
    component: ACCOUNT_PANEL_ID,
    title: PANEL_TITLES[ACCOUNT_PANEL_ID],
    renderer: "always",
    position: { direction: "below" },
    initialHeight: sizes.accountHeight,
  });

  // `initialWidth`/`initialHeight` above are only a hint for the panel being
  // added at that moment - inserting each later column steals space from
  // whatever the row already held, so the running total drifts from the
  // intended split by the time every column exists. Re-reading the layout,
  // pinning every explicit size directly in the serialized tree, and
  // reloading it fixes the real default in one pass - see `applyDefaultSizes`.
  const layout = api.toJSON();
  applyDefaultSizes(layout, sizes);
  api.fromJSON(layout);
}

/** Brings the privacy tools into the account group as extra tabs, behind the account itself. */
function addToolPanels(api: DockviewApi): void {
  for (const id of MAINNET_TOOLS_PANEL_IDS) {
    api.addPanel({
      id,
      component: id,
      title: MAINNET_PANEL_TITLES[id],
      renderer: "always",
      position: { referencePanel: ACCOUNT_PANEL_ID, direction: "within" },
      inactive: true,
    });
  }
}

function removeToolPanels(api: DockviewApi): void {
  for (const id of MAINNET_TOOLS_PANEL_IDS) {
    const panel = api.getPanel(id);
    if (panel) api.removePanel(panel);
  }
}

/** A group holding one panel needs no tab strip: the chart, the ticket and a lone account read as sections, not tabs. */
function applyMainnetHeaders(api: DockviewApi, tools: boolean): void {
  for (const id of [CHART_PANEL_ID, TICKET_PANEL_ID, ACCOUNT_PANEL_ID]) {
    const panel = api.getPanel(id);
    if (panel) panel.group.model.header.hidden = id === ACCOUNT_PANEL_ID ? !tools : true;
  }
}

function syncToolPanels(api: DockviewApi, tools: boolean): void {
  const present = !!api.getPanel(WITNESS_PANEL_ID);
  if (tools && !present) addToolPanels(api);
  if (!tools && present) removeToolPanels(api);
  applyMainnetHeaders(api, tools);
}

/**
 * The real-money arrangement: the chart wide on the left with the account
 * beneath it, the order ticket in a fixed-width column on the right. Sizes are
 * pinned in the serialized tree and loaded in one pass, as in the default
 * layout above.
 */
function buildMainnetLayout(
  api: DockviewApi,
  windowWidthPx: number,
  windowHeightPx: number,
  tools: boolean,
): void {
  const sizes = mainnetPanelSizes(windowWidthPx, windowHeightPx);
  api.addPanel({
    id: CHART_PANEL_ID,
    component: CHART_PANEL_ID,
    title: MAINNET_PANEL_TITLES[CHART_PANEL_ID],
    renderer: "always",
    minimumWidth: MIN_CHART_WIDTH,
    minimumHeight: MIN_CHART_HEIGHT,
  });
  api.addPanel({
    id: TICKET_PANEL_ID,
    component: TICKET_PANEL_ID,
    title: MAINNET_PANEL_TITLES[TICKET_PANEL_ID],
    renderer: "always",
    position: { referencePanel: CHART_PANEL_ID, direction: "right" },
    initialWidth: sizes.ticketWidth,
    minimumWidth: MAINNET_MIN_TICKET_WIDTH,
    maximumWidth: MAINNET_MAX_TICKET_WIDTH,
  });
  api.addPanel({
    id: ACCOUNT_PANEL_ID,
    component: ACCOUNT_PANEL_ID,
    title: MAINNET_PANEL_TITLES[ACCOUNT_PANEL_ID],
    renderer: "always",
    position: { referencePanel: CHART_PANEL_ID, direction: "below" },
    initialHeight: sizes.accountHeight,
  });
  if (tools) addToolPanels(api);

  const layout = api.toJSON();
  const root = layout.grid.root;
  if (root.type === "branch") {
    const rootChildren = root.data as GridNode[];
    sizeChildContaining(rootChildren, TICKET_PANEL_ID, sizes.ticketWidth);
    const chartColumn = rootChildren.find((child) => subtreeHasPanel(child, CHART_PANEL_ID));
    if (chartColumn && chartColumn.type === "branch") {
      sizeChildContaining(chartColumn.data as GridNode[], ACCOUNT_PANEL_ID, sizes.accountHeight);
    }
  }
  api.fromJSON(layout);
  applyMainnetHeaders(api, tools);
}

/**
 * The real docking board (dockview-react). Dynamically imported with
 * `ssr: false` by `DesktopWorkspace` - this file, and only this file,
 * depends on `dockview-react`, so the phone bundle never loads it.
 *
 * CRITICAL: every panel is added with `renderer: "always"`, dockview's
 * option for keeping a panel's DOM (and the React tree inside it) mounted
 * and merely repositioned, never destroyed, while it is a background tab,
 * off-screen behind a maximized sibling, or moved to another group. That is
 * what lets a half-typed order quantity, the chart's own instance, and the
 * account dock's selected tab survive every layout change - verified by
 * `e2e/layout-persistence.spec.ts`, not assumed.
 */
export function TerminalDockview({ resetSignal }: { resetSignal: number }) {
  const apiRef = useRef<DockviewApi | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetSignalRef = useRef(resetSignal);
  const mainnet = isMainnetBuild();
  const [privacyTools] = usePrivacyTools();
  const tools = mainnet && privacyTools;
  const toolsRef = useRef(tools);

  const buildDefault = useCallback(
    (api: DockviewApi) => {
      if (mainnet) buildMainnetLayout(api, window.innerWidth, window.innerHeight, toolsRef.current);
      else buildDefaultLayout(api, window.innerWidth, window.innerHeight);
    },
    [mainnet],
  );

  const scheduleSave = useCallback((api: DockviewApi) => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      saveStoredLayout(browserLayoutStorage(), api.toJSON());
    }, SAVE_DEBOUNCE_MS);
  }, []);

  const handleReady = useCallback(
    (event: DockviewReadyEvent) => {
      const { api } = event;
      apiRef.current = api;
      const saved = loadStoredLayout(
        browserLayoutStorage(),
        activePanelIds(mainnet, toolsRef.current),
      );
      let restored = false;
      if (saved) {
        try {
          // The validated shape is still dockview's own opaque payload, not
          // reconstructed here - `fromJSON` does the real, full validation
          // and is exactly what we want to fail loudly enough to catch.
          api.fromJSON(saved as Parameters<DockviewApi["fromJSON"]>[0]);
          restored = true;
        } catch {
          restored = false;
        }
      }
      if (!restored) {
        api.clear();
        buildDefault(api);
      } else if (mainnet) {
        applyMainnetHeaders(api, toolsRef.current);
      }
      api.onDidLayoutChange(() => scheduleSave(api));
    },
    [scheduleSave, buildDefault, mainnet],
  );

  // Switching the privacy tools on or off adds or removes their tabs in
  // place, so nothing else in the workspace is remounted or moved.
  useEffect(() => {
    toolsRef.current = tools;
    const api = apiRef.current;
    if (api && mainnet) syncToolPanels(api, tools);
  }, [tools, mainnet]);

  // The "Reset layout" link in the shell header bumps `resetSignal`; this
  // never fires on the initial mount (the ref starts equal to the prop).
  useEffect(() => {
    if (resetSignalRef.current === resetSignal) return;
    resetSignalRef.current = resetSignal;
    const api = apiRef.current;
    if (!api) return;
    clearStoredLayout(browserLayoutStorage());
    api.clear();
    buildDefault(api);
  }, [resetSignal, buildDefault]);

  useEffect(
    () => () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    },
    [],
  );

  return (
    <DockviewReact
      components={PANEL_COMPONENTS}
      defaultTabComponent={MaximizableTab}
      theme={mainnet ? mainnetDockviewTheme : noirwireDockviewTheme}
      disableFloatingGroups
      // Pointer events for every input, not only touch/pen: it drives the
      // drag gesture directly off the pointer position (no native-DnD ghost
      // image or OS-level drag session to add lag), and it is the strategy
      // a scripted mouse (Playwright, this suite's own e2e tests) can drive
      // reliably, where native HTML5 drag-and-drop often cannot be.
      dndStrategy="pointer"
      onReady={handleReady}
    />
  );
}
