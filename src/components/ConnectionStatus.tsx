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

/**
 * `marketDataStale` only changes the label while the socket itself is
 * `open`: the socket can be fully connected while the selected market's own
 * mark has gone past the program's 10-second freshness limit (sim-noirwire
 * paused, a slow price source), and a bare "Live" dot then contradicts the
 * market header's own stale warning right beside it (third design review,
 * must-fix 1). A lost connection already says so on its own.
 */
export function ConnectionStatus({
  state,
  marketDataStale = false,
}: {
  state: ConnectionState;
  marketDataStale?: boolean;
}) {
  const label =
    state === "open" && marketDataStale ? "Connected · market data stale" : LABELS[state];
  const dotClass = state === "open" && marketDataStale ? "bg-warning" : DOT_CLASS[state];
  return (
    <span className="text-dim inline-flex items-center gap-2 text-[12px]" aria-live="off">
      <span className={`h-2 w-2 rounded-full ${dotClass}`} aria-hidden="true" />
      {label}
    </span>
  );
}
