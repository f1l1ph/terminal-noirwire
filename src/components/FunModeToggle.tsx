"use client";

import { useEffect, useId, useRef, useState, type MouseEvent } from "react";
import { useFunMode } from "@/components/hooks/useFunMode";

function Switch({
  label,
  on,
  onChange,
  className,
}: {
  label: string;
  on: boolean;
  onChange: (next: boolean) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`rounded-tile text-ink hover:bg-elevated flex min-h-8 w-full items-center justify-between gap-4 px-2 text-[12px] ${className ?? ""}`}
    >
      {label}
      <span
        aria-hidden="true"
        className={`flex h-4 w-7 shrink-0 items-center rounded-full px-0.5 transition-colors ${on ? "bg-warning" : "bg-line-strong"}`}
      >
        <span
          className={`bg-base h-3 w-3 rounded-full transition-transform ${on ? "translate-x-3" : ""}`}
        />
      </span>
    </button>
  );
}

/** The header switch between Normal and Fun, and the small popover that picks which Fun visuals show. */
export function FunModeToggle() {
  const [settings, update] = useFunMode();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();

  const toggleSettings = (event: MouseEvent<HTMLButtonElement>) => {
    openerRef.current = event.currentTarget;
    setOpen((value) => !value);
  };

  useEffect(() => {
    if (!open) return;
    const buttons = Array.from(popoverRef.current?.querySelectorAll<HTMLElement>("button") ?? []);
    buttons.find((button) => button.offsetParent !== null)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      openerRef.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative flex items-center">
      <button
        type="button"
        aria-pressed={settings.enabled}
        aria-label="Fun mode"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={toggleSettings}
        className="rounded-tile text-faint hover:text-ink relative inline-flex h-8 w-8 items-center justify-center transition-colors sm:hidden"
      >
        <svg
          aria-hidden="true"
          width="18"
          height="18"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M8 1.5L4.3 10.5h7.4z" />
          <path d="M2.5 10.5h11M5 13.5h6" />
        </svg>
        <span
          aria-hidden="true"
          className={`absolute top-1 right-1 h-1.5 w-1.5 rounded-full ${settings.enabled ? "bg-warning" : "bg-line-strong"}`}
        />
      </button>
      <button
        type="button"
        aria-pressed={settings.enabled}
        aria-label="Fun mode"
        onClick={() => update({ enabled: !settings.enabled })}
        className="rounded-tile text-faint hover:text-ink hidden min-h-8 items-center gap-1.5 px-2 text-[12px] whitespace-nowrap transition-colors sm:inline-flex"
      >
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 rounded-full ${settings.enabled ? "bg-warning" : "bg-line-strong"}`}
        />
        Fun
      </button>
      <button
        type="button"
        aria-label="Fun mode settings"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={toggleSettings}
        className="rounded-tile text-faint hover:text-ink hidden h-8 w-7 items-center justify-center transition-colors sm:inline-flex"
      >
        <svg
          aria-hidden="true"
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        >
          <path d="M2 4.5h7M12.5 4.5H14M2 11.5h1.5M7 11.5H14" />
          <circle cx="10.75" cy="4.5" r="1.75" />
          <circle cx="5.25" cy="11.5" r="1.75" />
        </svg>
      </button>
      {open && (
        <div
          ref={popoverRef}
          id={popoverId}
          role="group"
          aria-label="Fun mode settings"
          className="border-line bg-surface-raised rounded-panel absolute top-full right-0 mt-1 w-56 max-w-[calc(100vw-1.5rem)] border p-2 whitespace-normal shadow-lg max-sm:fixed max-sm:top-12 max-sm:right-3"
        >
          <Switch
            label="Fun mode"
            on={settings.enabled}
            onChange={(enabled) => update({ enabled })}
            className="sm:hidden"
          />
          <Switch label="Screen tint" on={settings.tint} onChange={(tint) => update({ tint })} />
          <Switch label="Wizard" on={settings.wizard} onChange={(wizard) => update({ wizard })} />
          <p className="text-faint px-2 pt-1 pb-0.5 text-[11px] leading-snug">
            Visuals only. Prices and orders do not change.
          </p>
        </div>
      )}
    </div>
  );
}
