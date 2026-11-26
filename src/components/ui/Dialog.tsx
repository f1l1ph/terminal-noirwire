"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

const BACKDROP_CLASS: Record<DialogPlacement, string> = {
  center: "bg-base/80 fixed inset-0 z-30 flex items-center justify-center p-4",
  sheet: "bg-base/80 fixed inset-0 z-30 flex items-end justify-center sm:items-center sm:p-4",
};
const CARD_CLASS: Record<DialogPlacement, string> = {
  center:
    "bg-surface border-line-strong rounded-panel max-h-full w-full max-w-sm overflow-y-auto border p-5",
  sheet:
    "bg-surface border-line-strong max-sm:rounded-t-panel sm:rounded-panel flex max-h-[92dvh] w-full flex-col overflow-hidden border max-sm:border-b-0 sm:max-w-md",
};

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

function focusableIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
}

/** A dialog is named by a visible heading (`titleId`) or, with none, by a plain `label`. */
export type DialogName = { titleId: string } | { label: string };

/** `center` is a card in the middle; `sheet` rises from the bottom edge on a phone and is centred from the small-tablet width up. */
export type DialogPlacement = "center" | "sheet";

/**
 * The modal shell: a portal over the page with a backdrop, Escape and
 * backdrop dismissal, a Tab trap, and focus handed back to whatever held it
 * before. The first element marked `data-initial-focus` takes focus, again
 * whenever `focusKey` changes.
 *
 * It renders into `document.body`, not in place: nested inside a dockview
 * panel, the ancestor chain includes an element with its own CSS transform
 * (dockview's overlay renderer), and a transformed ancestor makes any
 * descendant's `position: fixed` relative to that box instead of the
 * viewport, which would strand the dialog over one small panel rather than
 * the screen.
 */
export function Dialog({
  name,
  onDismiss,
  focusKey,
  placement = "center",
  children,
}: {
  name: DialogName;
  onDismiss: () => void;
  focusKey?: unknown;
  placement?: DialogPlacement;
  children: ReactNode;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<Element | null>(null);
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  });

  useEffect(() => {
    returnFocusRef.current = document.activeElement;
    const card = cardRef.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dismissRef.current();
        return;
      }
      if (event.key !== "Tab" || !card) return;
      const items = focusableIn(card);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (!card.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const previous = returnFocusRef.current;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  useEffect(() => {
    cardRef.current?.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
  }, [focusKey]);

  return createPortal(
    <div
      className={BACKDROP_CLASS[placement]}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onDismiss();
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={"titleId" in name ? name.titleId : undefined}
        aria-label={"label" in name ? name.label : undefined}
        className={CARD_CLASS[placement]}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
