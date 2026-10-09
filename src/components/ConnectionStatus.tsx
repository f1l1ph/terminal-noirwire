import type { ConnectionState } from "@/lib/market-data/socket";

/**
 * "Connection lost" for both `reconnecting` and `closed`: an unexpected
 * drop always retries on its own, so the trader never needs to tell the two
 * apart; the dot still distinguishes an active retry from a fully stopped
 * socket.
 */
const LABELS: Record<ConnectionState, string> = {
  connecting: "Connecting",
  open: "Live",
  reconnecting: "Connection lost",
  closed: "Connection lost",
};

const DOT_CLASS: Record<ConnectionState, string> = {
  connecting: "bg-warning",
  open: "bg-safe live-dot",
  reconnecting: "bg-danger live-dot",
  closed: "bg-danger",
};

export function ConnectionStatus({ state }: { state: ConnectionState }) {
  return (
    <span className="text-dim inline-flex items-center gap-2 text-[12px]" aria-live="off">
      <span className={`h-2 w-2 rounded-full ${DOT_CLASS[state]}`} aria-hidden="true" />
      {LABELS[state]}
    </span>
  );
}
