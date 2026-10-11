"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  clampCentreSplit,
  clampDockHeight,
  clampColumnWidthsToContainer,
  defaultLayout,
  isDefaultLayout,
  loadPanelLayout,
  moveColumn,
  resizeCentreSplit,
  resizeColumnBoundary,
  resizeDock,
  savePanelLayout,
  swapCentre,
  swapColumns,
  toggleCollapsed,
  type CollapsiblePanelId,
  type ColumnSlotId,
  type LayoutStorage,
  type PanelLayoutState,
} from "@/lib/layout/panelLayout";

/**
 * The layout used for the server render and the very first client render,
 * before the mount effect below can read the real window size - picked so
 * both renders are byte-identical (no hydration mismatch). The saved or
 * width-correct default lands a moment later, the same pattern
 * `useMediaQuery` already uses for `isDesktop`.
 */
const SSR_WIDTH = 1440;

function browserStorage(): LayoutStorage | null {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

export function usePanelLayout() {
  const [state, setState] = useState<PanelLayoutState>(() => defaultLayout(SSR_WIDTH));
  const [hydrated, setHydrated] = useState(false);
  const [windowWidth, setWindowWidth] = useState(SSR_WIDTH);

  useEffect(() => {
    // The saved-or-default layout is read once, from an external source
    // (localStorage, the real window size) the server and first client
    // render cannot see - exactly the documented case for syncing state in
    // an effect rather than during render.
    const width = window.innerWidth;
    const height = window.innerHeight;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWindowWidth(width);
    setState(loadPanelLayout(browserStorage(), width, height));
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    savePanelLayout(browserStorage(), state);
  }, [state, hydrated]);

  // Re-clamps stored sizes against the window on resize, so a session that
  // starts wide and is then narrowed never leaves a panel wider than the
  // viewport that has to render it.
  useEffect(() => {
    function handleResize() {
      const width = window.innerWidth;
      const height = window.innerHeight;
      setWindowWidth(width);
      setState((prev) => ({
        ...prev,
        sizes: {
          ...clampColumnWidthsToContainer(prev.sizes, width),
          dock: clampDockHeight(prev.sizes.dock, height),
          centreSplit: clampCentreSplit(prev.sizes.centreSplit),
        },
      }));
    }
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const reset = useCallback(() => {
    setState(defaultLayout(window.innerWidth));
  }, []);

  const swapColumnSlots = useCallback((a: ColumnSlotId, b: ColumnSlotId) => {
    setState((prev) => swapColumns(prev, a, b));
  }, []);

  const moveColumnSlot = useCallback((slot: ColumnSlotId, direction: -1 | 1) => {
    setState((prev) => moveColumn(prev, slot, direction));
  }, []);

  const swapCentreRows = useCallback(() => {
    setState((prev) => swapCentre(prev));
  }, []);

  const toggleCollapse = useCallback((panel: CollapsiblePanelId) => {
    setState((prev) => toggleCollapsed(prev, panel));
  }, []);

  const resizeBoundary = useCallback(
    (
      leftSlot: ColumnSlotId,
      rightSlot: ColumnSlotId,
      deltaPx: number,
      containerWidthPx: number,
    ) => {
      setState((prev) =>
        resizeColumnBoundary(prev, leftSlot, rightSlot, deltaPx, containerWidthPx),
      );
    },
    [],
  );

  const resizeCentre = useCallback((deltaPx: number, totalHeightPx: number) => {
    setState((prev) => resizeCentreSplit(prev, deltaPx, totalHeightPx));
  }, []);

  const resizeDockHeight = useCallback((deltaPx: number, windowHeightPx: number) => {
    setState((prev) => resizeDock(prev, deltaPx, windowHeightPx));
  }, []);

  const isDefault = useMemo(() => isDefaultLayout(state, windowWidth), [state, windowWidth]);

  return {
    state,
    hydrated,
    isDefault,
    reset,
    swapColumnSlots,
    moveColumnSlot,
    swapCentreRows,
    toggleCollapse,
    resizeBoundary,
    resizeCentre,
    resizeDockHeight,
  };
}

export type PanelLayoutController = ReturnType<typeof usePanelLayout>;
