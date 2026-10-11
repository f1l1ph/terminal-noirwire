"use client";

import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { panel, sectionLabel } from "@/components/ui/styles";

export interface PanelGripConfig {
  label: string;
  dragging: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}

export interface PanelCollapseConfig {
  collapsed: boolean;
  /** "column": collapses to a narrow vertical strip. "row": collapses to title-bar height. */
  orientation: "column" | "row";
  onToggle: () => void;
}

/**
 * The one frame every desktop panel shares: a slim title bar (name, an
 * optional drag grip, an optional collapse toggle) over a body that always
 * stays mounted - a collapsed panel is hidden with CSS, never unmounted, so
 * the order ticket, the chart and the account dock never lose state when
 * another panel collapses around them.
 */
export function PanelFrame({
  title,
  grip,
  collapse,
  dropHighlight = false,
  bodyClassName = "",
  className = "",
  children,
}: {
  title: string;
  grip?: PanelGripConfig;
  collapse?: PanelCollapseConfig;
  dropHighlight?: boolean;
  bodyClassName?: string;
  /** Extra classes for the frame's own root element - e.g. `flex-1` when a single-child grid-item wrapper needs this frame to fill it. */
  className?: string;
  children: ReactNode;
}) {
  const columnCollapsed = collapse?.collapsed && collapse.orientation === "column";

  return (
    <div
      className={`${panel} flex min-h-0 min-w-0 flex-col ${dropHighlight ? "ring-ink-strong ring-2 ring-inset" : ""} ${className}`}
      // An inline style, not a `border-*` utility class: the base `panel`
      // class already sets a border colour, and which of two same-specificity
      // utility classes wins depends on Tailwind's generated stylesheet
      // order, not on this string's order - a style attribute always wins.
      style={dropHighlight ? { borderColor: "var(--color-ink-strong)" } : undefined}
    >
      <div
        className={`border-line-subtle flex shrink-0 items-center gap-1 border-b px-1.5 ${
          columnCollapsed ? "h-auto flex-col gap-1.5 py-2" : "h-8"
        }`}
      >
        {grip && (
          <div
            role="button"
            tabIndex={0}
            aria-label={grip.label}
            onPointerDown={grip.onPointerDown}
            onPointerMove={grip.onPointerMove}
            onPointerUp={grip.onPointerUp}
            onPointerCancel={grip.onPointerUp}
            onKeyDown={grip.onKeyDown}
            className={`text-faint hover:text-ink flex shrink-0 cursor-grab items-center justify-center rounded px-1 text-[12px] leading-none active:cursor-grabbing ${
              grip.dragging ? "text-ink-strong" : ""
            }`}
            style={{ touchAction: "none" }}
          >
            ⠿
          </div>
        )}
        <span
          className={`${sectionLabel} ${columnCollapsed ? "[writing-mode:vertical-rl]" : "min-w-0 flex-1 truncate"}`}
        >
          {title}
        </span>
        {collapse && (
          <button
            type="button"
            aria-label={`${collapse.collapsed ? "Expand" : "Collapse"} ${title} panel`}
            aria-pressed={collapse.collapsed}
            onClick={collapse.onToggle}
            className="text-faint hover:text-ink shrink-0 rounded px-1 text-[11px] leading-none"
          >
            {collapse.orientation === "column"
              ? collapse.collapsed
                ? "›"
                : "‹"
              : collapse.collapsed
                ? "⌄"
                : "⌃"}
          </button>
        )}
      </div>
      <div
        className={`min-h-0 min-w-0 flex-1 flex-col ${collapse?.collapsed ? "hidden" : "flex"} ${bodyClassName}`}
        aria-hidden={collapse?.collapsed || undefined}
      >
        {children}
      </div>
    </div>
  );
}
