"use client";

import {
  useRef,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

const KEY_STEP = 8;
const KEY_STEP_LARGE = 24;

/**
 * A draggable boundary between two panels - Pointer Events with pointer
 * capture, plus a keyboard path (focus the separator, arrow keys move it).
 * Stateless: it only reports movement, via `onDelta`; the caller (the
 * layout hook's resize actions) owns clamping and what the delta resizes.
 */
export function Splitter({
  orientation,
  label,
  valueNow,
  valueMin,
  valueMax,
  onDelta,
  disabled = false,
  className = "",
  style,
}: {
  /** "column": a vertical bar, dragged left/right, resizes a column width. "row": a horizontal bar, dragged up/down, resizes a row height. */
  orientation: "column" | "row";
  label: string;
  valueNow: number;
  valueMin: number;
  valueMax: number;
  /** Positive is right (column) or down (row). */
  onDelta: (deltaPx: number) => void;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const dragPointerId = useRef<number | null>(null);
  const lastPosition = useRef(0);

  function positionOf(event: { clientX: number; clientY: number }): number {
    return orientation === "column" ? event.clientX : event.clientY;
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (disabled) return;
    event.preventDefault();
    dragPointerId.current = event.pointerId;
    lastPosition.current = positionOf(event);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragPointerId.current !== event.pointerId) return;
    const position = positionOf(event);
    const delta = position - lastPosition.current;
    if (delta === 0) return;
    lastPosition.current = position;
    onDelta(delta);
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragPointerId.current !== event.pointerId) return;
    dragPointerId.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const positiveKey = orientation === "column" ? "ArrowRight" : "ArrowDown";
    const negativeKey = orientation === "column" ? "ArrowLeft" : "ArrowUp";
    if (event.key === positiveKey) {
      event.preventDefault();
      onDelta(step);
    } else if (event.key === negativeKey) {
      event.preventDefault();
      onDelta(-step);
    }
  }

  const base =
    orientation === "column" ? "w-2 shrink-0 cursor-col-resize" : "h-2 shrink-0 cursor-row-resize";

  return (
    <div
      role="separator"
      aria-orientation={orientation === "column" ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuenow={Math.round(valueNow)}
      aria-valuemin={Math.round(valueMin)}
      aria-valuemax={Math.round(valueMax)}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
      className={`group flex items-center justify-center ${disabled ? "pointer-events-none opacity-0" : ""} ${base} ${className}`}
      style={{ touchAction: "none", ...style }}
    >
      <span
        className={`bg-line group-hover:bg-line-strong group-focus-visible:bg-ink-strong rounded-full ${
          orientation === "column" ? "h-8 w-[3px]" : "h-[3px] w-8"
        }`}
      />
    </div>
  );
}
