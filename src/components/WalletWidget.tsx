"use client";

import { useEffect, useRef, useState } from "react";
import { formatShortAddress } from "@/lib/format";
import type { WalletHookResult } from "@/lib/wallet/useWallet";
import { btnGhost, input, panel } from "@/components/ui/styles";

export function WalletWidget({ wallet }: { wallet: WalletHookResult }) {
  const [open, setOpen] = useState(false);
  const [importValue, setImportValue] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => {
      setOpen(false);
      setRevealed(null);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // No wallet yet: the order panel is the one place that creates one (never
  // a second "Create test wallet" button here too).
  if (!wallet.ready) return <span className="text-faint text-[12px]">Loading wallet…</span>;
  if (!wallet.account) return null;

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        className="border-line text-ink rounded-tile min-h-11 border px-3 text-[13px]"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {formatShortAddress(wallet.account.publicKey)}
      </button>
      {open && (
        <div className={`${panel} absolute right-0 z-10 mt-2 w-80 p-4`}>
          <p className="text-ink text-[13px] break-all">{wallet.account.publicKey}</p>
          <p className="text-faint mt-1 text-[12px]">Stored on this device.</p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className={`${btnGhost} h-9 flex-1 text-[12px]`}
              onClick={() => setRevealed(wallet.exportCurrent())}
            >
              Save recovery details
            </button>
          </div>
          {revealed && (
            <div className="bg-surface-raised rounded-tile mt-3 p-3">
              <p className="text-faint text-[11px]">
                Secret (hex). Keep it private; anyone with it controls this wallet.
              </p>
              <p className="tnum text-ink mt-1 text-[11px] break-all">{revealed}</p>
            </div>
          )}
          <div className="border-line-subtle mt-4 border-t pt-3">
            <label className="text-faint text-[12px]" htmlFor="wallet-import">
              Import a saved secret
            </label>
            <input
              id="wallet-import"
              className={`${input} mt-2`}
              value={importValue}
              onChange={(event) => {
                setImportValue(event.target.value);
                setImportError(null);
              }}
              placeholder="Secret (hex)"
            />
            {importError && <p className="text-danger mt-1 text-[12px]">{importError}</p>}
            <button
              type="button"
              className={`${btnGhost} mt-2 h-9 w-full text-[12px]`}
              onClick={() => {
                try {
                  wallet.importSecret(importValue);
                  setImportValue("");
                  setOpen(false);
                } catch {
                  setImportError("Wallet not imported. Check the secret and try again.");
                }
              }}
            >
              Import
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
