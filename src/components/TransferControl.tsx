"use client";

import { useEffect, useState } from "react";
import { formatMoney } from "@/lib/format";
import type { Balance, TransferResult } from "@/lib/trading/types";
import { btnGhost, btnPrimary, input, sectionLabel } from "@/components/ui/styles";

/** A local, one-second ticker while this control is awaiting a pending transfer's settlement - self-contained, so a countdown needs no `now` prop threaded through AccountDock/BalancesTable. */
function useLocalNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export type TransferFn = (toSpot: boolean, amount: string) => Promise<TransferResult>;

/**
 * Moves funds between the perpetuals collateral account and the spot
 * balance of the same asset (RULES.md section 6: "two separate balances of
 * the same token"). Rollup mode only; absent entirely when `onTransfer` is
 * not given (dev mode has one balance, nothing to move between).
 */
export function TransferControl({
  onTransfer,
  collateral,
  spot,
  prefillAmount,
  initiallyOpen,
  onDone,
}: {
  onTransfer: TransferFn;
  collateral: Balance;
  spot: Balance | null;
  /** Pre-fills the amount, for "Move funds to spot" from order entry. */
  prefillAmount?: string;
  /** Opens the control immediately rather than showing the collapsed button first. */
  initiallyOpen?: boolean;
  onDone?: () => void;
}) {
  const [open, setOpen] = useState(!!initiallyOpen || !!prefillAmount);
  // Both `initiallyOpen` and `prefillAmount` only ever come from the same
  // place - order entry's "Move funds to spot" - so either one means the
  // direction defaults to spot too; a quantity not yet typed in the order
  // form (so no prefillAmount) must not silently flip it to the opposite
  // direction, which moved funds OUT of an empty spot balance and was
  // refused on chain (InsufficientBalance) with no visible reason.
  const [direction, setDirection] = useState<"toSpot" | "toCollateral">(
    initiallyOpen || prefillAmount ? "toSpot" : "toCollateral",
  );
  const [amount, setAmount] = useState(prefillAmount ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingExpiresAtMs, setPendingExpiresAtMs] = useState<number | null>(null);
  const now = useLocalNow(pendingExpiresAtMs !== null);

  if (!open) {
    return (
      <button
        type="button"
        className={`${btnGhost} mt-2 h-8 w-full px-3 text-[12px]`}
        onClick={() => setOpen(true)}
      >
        Transfer between collateral and spot
      </button>
    );
  }

  function finish(result: TransferResult) {
    if (result.kind === "ok") {
      setMessage(null);
      setAmount("");
      setOpen(false);
      onDone?.();
    } else if (result.kind === "pending") {
      // Should not recur (a pending transfer settles to ok/error, never to
      // another pending), but handled plainly rather than assumed away.
      setMessage("Still checking with the venue.");
    } else {
      setMessage(result.message);
    }
  }

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      const result = await onTransfer(direction === "toSpot", amount);
      if (result.kind === "pending") {
        // The call's own order-key slot stays lent until this resolves, so
        // the Move button below stays disabled (via `busy`) the whole time:
        // resending the same transfer is blocked, but placing an order or
        // cancelling one elsewhere in the terminal is not.
        setMessage("Checking with the venue. Do not resend yet.");
        setPendingExpiresAtMs(result.pending.expiresAtMs);
        const settled = await result.pending.settled;
        setPendingExpiresAtMs(null);
        finish(settled);
        return;
      }
      finish(result);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-line-subtle mt-2 border-t pt-2">
      <p className={sectionLabel}>Transfer</p>
      <p className="text-faint mt-1 text-[11px]">
        Collateral {formatMoney(collateral.available)} · Spot {formatMoney(spot?.available ?? "0")}
      </p>
      <div className="mt-2 flex gap-2" role="group" aria-label="Direction">
        <button
          type="button"
          aria-pressed={direction === "toSpot"}
          onClick={() => setDirection("toSpot")}
          className={`rounded-tile min-h-8 flex-1 border px-2 text-[11px] ${direction === "toSpot" ? "border-line-strong bg-elevated text-ink" : "border-line text-dim"}`}
        >
          Collateral → Spot
        </button>
        <button
          type="button"
          aria-pressed={direction === "toCollateral"}
          onClick={() => setDirection("toCollateral")}
          className={`rounded-tile min-h-8 flex-1 border px-2 text-[11px] ${direction === "toCollateral" ? "border-line-strong bg-elevated text-ink" : "border-line text-dim"}`}
        >
          Spot → Collateral
        </button>
      </div>
      <input
        className={`${input} mt-2`}
        inputMode="decimal"
        placeholder="0.00"
        value={amount}
        onChange={(event) => setAmount(event.target.value)}
        aria-label="Transfer amount (nUSD)"
      />
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          className={`${btnGhost} h-8 flex-1 text-[12px]`}
          onClick={() => {
            setOpen(false);
            setMessage(null);
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          className={`${btnPrimary} h-8 flex-1 text-[12px]`}
          disabled={busy || !amount.trim() || Number(amount) <= 0}
          onClick={() => void submit()}
        >
          {busy ? "Moving…" : "Move"}
        </button>
      </div>
      {message && (
        <p
          role="alert"
          className={`mt-1 text-[12px] ${pendingExpiresAtMs !== null ? "text-faint" : "text-danger"}`}
        >
          {message}
          {pendingExpiresAtMs !== null &&
            ` About ${Math.max(0, Math.ceil((pendingExpiresAtMs - now) / 1000))}s.`}
        </p>
      )}
    </div>
  );
}
