"use client";

export function Switch({
  label,
  on,
  onChange,
}: {
  label: string;
  on: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="rounded-tile text-ink hover:bg-elevated flex min-h-8 w-full items-center justify-between gap-4 px-2 text-[12px]"
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
