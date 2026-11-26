"use client";

import { useEffect, useRef, type RefObject } from "react";

/** While `open`, closes on a press outside `containerRef` or on Escape; `onEscape` runs just before the close on Escape only. */
export function useDismissOnOutside(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  close: () => void,
  onEscape?: () => void,
) {
  const closeRef = useRef(close);
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    closeRef.current = close;
    onEscapeRef.current = onEscape;
  });

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) closeRef.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onEscapeRef.current?.();
      closeRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, containerRef]);
}
