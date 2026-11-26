/**
 * Shared Tailwind class strings, so every panel, input and button draws
 * from the same tokens in globals.css rather than repeating raw utility
 * lists across components.
 */
export const panel = "bg-surface border border-line-subtle rounded-panel";
export const tile = "bg-surface-raised border border-line-subtle rounded-tile";

const btnBase =
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

/**
 * An opaque ground behind a full-width row across the panel column only
 * (the main column's px-3 sm:px-4), so the gutters stay open to the Fun
 * light. The row needs `relative`; `isolate` keeps the ground behind its content.
 */
export const panelColumnGround =
  "isolate before:absolute before:inset-y-0 before:inset-x-3 before:-z-10 before:bg-base sm:before:inset-x-4";

/** The header chip's visible box: 32px, the height of the header's other controls, clear of the screen-edge ring. */
export const headerChipBox = "border-line text-ink rounded-tile min-h-8 border px-3 text-[13px]";

/** The chip box plus an invisible hit area 6px past the border above and below, keeping a 44px touch target. */
export const headerChip = `${headerChipBox} relative before:absolute before:inset-x-0 before:-inset-y-[7px]`;
