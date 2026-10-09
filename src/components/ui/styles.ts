/**
 * Shared Tailwind class strings, so every panel, input and button draws
 * from the same tokens in globals.css rather than repeating raw utility
 * lists across components.
 */
export const panel = "bg-surface border border-line-subtle rounded-panel";
export const tile = "bg-surface-raised border border-line-subtle rounded-tile";

export const btnBase =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-tile px-4 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40";

/*
 * `text-(--color-base)` rather than `text-base`: Tailwind's built-in
 * font-size scale already owns the name "text-base" (1rem), so the themed
 * color token is only reachable through the explicit CSS-variable form.
 */
export const btnPrimary = `${btnBase} bg-ink-strong text-(--color-base) hover:bg-ink`;
export const btnGhost = `${btnBase} border border-line text-ink hover:bg-surface-raised`;
export const btnSafe = `${btnBase} bg-safe text-(--color-base) hover:opacity-90`;
export const btnDanger = `${btnBase} bg-danger text-(--color-base) hover:opacity-90`;

export const input =
  "bg-surface-raised border border-line rounded-tile px-3 py-2 text-[14px] text-ink placeholder:text-faint focus:border-line-strong outline-none w-full";

export const sectionLabel = "text-faint text-[11px] tracking-wide uppercase";

export const rangeBrand = "range-brand w-full";
