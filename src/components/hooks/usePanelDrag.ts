"use client";

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/**
 * Drag-to-swap for a small, fixed set of panel ids (the four column slots,
 * or the chart/tape pair). A grip's `onPointerDown` starts the drag and
 * captures the pointer on itself, so every later move/up for that gesture
 * keeps arriving here even once the cursor leaves the grip - no document
 * listeners needed. Hit-testing is a plain bounding-rect check against each
 * panel's rect, captured once at drag start (panels do not move during a
 * drag, only the drop highlight does).
 */
export function usePanelDrag<T extends string>(order: readonly T[], onSwap: (a: T, b: T) => void) {
  const [draggingId, setDraggingId] = useState<T | null>(null);
  const [hoverId, setHoverId] = useState<T | null>(null);
  const panelRefs = useRef(new Map<T, HTMLElement>());
  const panelRects = useRef(new Map<T, DOMRect>());

  const registerPanel = useCallback(
    (id: T) => (element: HTMLElement | null) => {
      if (element) panelRefs.current.set(id, element);
      else panelRefs.current.delete(id);
    },
    [],
  );

  const handleGripPointerDown = useCallback(
    (id: T) => (event: ReactPointerEvent<HTMLElement>) => {
      event.preventDefault();
      panelRects.current.clear();
      for (const key of order) {
        const element = panelRefs.current.get(key);
        if (element) panelRects.current.set(key, element.getBoundingClientRect());
      }
      setDraggingId(id);
      setHoverId(null);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [order],
  );

  const handleGripPointerMove = useCallback(
    (id: T) => (event: ReactPointerEvent<HTMLElement>) => {
      if (draggingId !== id) return;
      const { clientX, clientY } = event;
      let hit: T | null = null;
      for (const key of order) {
        if (key === id) continue;
        const rect = panelRects.current.get(key);
        if (
          rect &&
          clientX >= rect.left &&
          clientX <= rect.right &&
          clientY >= rect.top &&
          clientY <= rect.bottom
        ) {
          hit = key;
          break;
        }
      }
      setHoverId(hit);
    },
    [draggingId, order],
  );

  const endDrag = useCallback(
    (id: T) => (event: ReactPointerEvent<HTMLElement>) => {
      if (draggingId !== id) return;
      if (hoverId) onSwap(id, hoverId);
      setDraggingId(null);
      setHoverId(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [draggingId, hoverId, onSwap],
  );

  return {
    draggingId,
    hoverId,
    registerPanel,
    handleGripPointerDown,
    handleGripPointerMove,
    endDrag,
  };
}
