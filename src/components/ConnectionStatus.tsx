import type { ConnectionState } from "@/lib/market-data/socket";

/**
 * The state of the market-data socket and nothing else: the price's own age is
 * shown by the price header. An open socket is a quiet dot with no text; the
 * words appear only while the connection is being made or has dropped, and on
 * a narrow screen those collapse to the dot, the full text kept in the label.
 */
const LABELS: Record<ConnectionState, string> = {
  connecting: "Connecting",
  open: "Connected",
  reconnecting: "Connection lost, reconnecting",
  closed: "Connection lost, reconnecting",
};

const DOT_CLASS: Record<ConnectionState, string> = {
  connecting: "bg-warning",
  open: "bg-safe",
  reconnecting: "bg-danger live-dot",
  closed: "bg-danger live-dot",
};

export function ConnectionStatus({ state }: { state: ConnectionState }) {
  const label = LABELS[state];
  return (
    <span
      className="text-dim inline-flex shrink-0 items-center gap-2 text-[12px] whitespace-nowrap"
      role="status"
      aria-label={label}
      title={label}
    >
      <span className={`h-2 w-2 rounded-full ${DOT_CLASS[state]}`} aria-hidden="true" />
      <span className={state === "open" ? "sr-only" : "sr-only sm:not-sr-only"}>{label}</span>
    </span>
  );
}
