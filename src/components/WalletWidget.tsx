"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Wallet } from "@wallet-standard/base";
import { formatShortAddress } from "@/lib/format";
import { isMainnetBuild } from "@/lib/network";
import { useStandardWallet } from "@/lib/wallet/standardWallet";
import {
  browserLocalStorage,
  keptWalletAddress,
  MIN_PASSPHRASE_LENGTH,
  WalletExistsError,
} from "@/lib/wallet/index";
import type { WalletHookResult } from "@/lib/wallet/useWallet";
import { btnGhost, input, panel } from "@/components/ui/styles";

/** Fields that carry a secret: never autofilled, autocorrected or sent to a spell-check service. */
const secretFieldProps = {
  type: "password",
  autoComplete: "off",
  autoCapitalize: "off",
  autoCorrect: "off",
  spellCheck: false,
} as const;

/** Why a new passphrase cannot be used yet, or null once it can. */
function newPassphraseProblem(passphrase: string, repeated: string): string | null {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return `Use at least ${MIN_PASSPHRASE_LENGTH} characters.`;
  }
  if (repeated !== passphrase) return "The two passphrases do not match.";
  return null;
}

function PassphraseForm({
  id,
  label,
  action,
  busyAction,
  isNew = false,
  onSubmit,
}: {
  id: string;
  label: string;
  action: string;
  busyAction: string;
  /** A passphrase being chosen: it has a minimum length and is typed twice, since a typo would lock the wallet for good. */
  isNew?: boolean;
  onSubmit: (passphrase: string) => Promise<string | null>;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [repeated, setRepeated] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!passphrase || busy) return;
        const problem = isNew ? newPassphraseProblem(passphrase, repeated) : null;
        if (problem) {
          setError(problem);
          return;
        }
        setBusy(true);
        void onSubmit(passphrase)
          .then((failure) => {
            setError(failure);
            if (!failure) {
              setPassphrase("");
              setRepeated("");
            }
          })
          .finally(() => setBusy(false));
      }}
    >
      <label className="text-faint text-[12px]" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        {...secretFieldProps}
        className={`${input} mt-2`}
        value={passphrase}
        onChange={(event) => {
          setPassphrase(event.target.value);
          setError(null);
        }}
        placeholder={isNew ? `Passphrase, ${MIN_PASSPHRASE_LENGTH}+ characters` : "Passphrase"}
      />
      {isNew && (
        <>
          <label className="sr-only" htmlFor={`${id}-repeat`}>
            Repeat the passphrase
          </label>
          <input
            id={`${id}-repeat`}
            {...secretFieldProps}
            className={`${input} mt-2`}
            value={repeated}
            onChange={(event) => {
              setRepeated(event.target.value);
              setError(null);
            }}
            placeholder="Repeat the passphrase"
          />
        </>
      )}
      {error && <p className="text-danger mt-1 text-[12px]">{error}</p>}
      <button
        type="submit"
        className={`${btnGhost} mt-2 h-9 w-full text-[12px]`}
        disabled={!passphrase || busy}
      >
        {busy ? busyAction : action}
      </button>
    </form>
  );
}

/**
 * The wallet control in the header. A mainnet build lists the wallets in the
 * browser and never offers to hold a secret; a test build keeps the built-in
 * wallet.
 */
export function WalletWidget({ wallet }: { wallet: WalletHookResult }) {
  return isMainnetBuild() ? <ExternalWalletWidget /> : <BuiltInWalletWidget wallet={wallet} />;
}

/** Closes the panel on a click outside `containerRef` or on Escape. */
function useDismissOnOutside(
  open: boolean,
  containerRef: RefObject<HTMLDivElement | null>,
  close: () => void,
) {
  useEffect(() => {
    if (!open) return;
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
  }, [open, containerRef, close]);
}

const CONNECT_FAILED = "Could not connect. Check the wallet and try again.";
const MAX_REASON_LENGTH = 160;

/** The generic failure plus the wallet's own reason (a rejection, a locked wallet), so a refusal can be told from a fault. */
function connectFailure(error: unknown): string {
  const reason = error instanceof Error ? error.message.trim().slice(0, MAX_REASON_LENGTH) : "";
  return reason ? `${CONNECT_FAILED} The wallet said: ${reason}` : CONNECT_FAILED;
}

/** Phantom, Solflare and any other Wallet Standard wallet that signs for Solana mainnet: connect, show and copy the address, disconnect. */
function ExternalWalletWidget() {
  const { wallets, signer, connecting, connect, disconnect } = useStandardWallet();
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissOnOutside(open, containerRef, close);

  const address = signer?.publicKey.toBase58() ?? null;

  async function choose(wallet: Wallet) {
    setProblem(null);
    try {
      await connect(wallet);
      setOpen(false);
    } catch (error) {
      setProblem(connectFailure(error));
    }
  }

  async function copyAddress() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        className="border-line text-ink rounded-tile min-h-11 border px-3 text-[13px]"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {connecting ? "Connecting…" : address ? formatShortAddress(address) : "Connect wallet"}
      </button>
      {open && (
        <div className={`${panel} absolute right-0 z-10 mt-2 w-80 p-4`}>
          {address ? (
            <>
              <p className="text-ink text-[13px] break-all">{address}</p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  className={`${btnGhost} h-9 flex-1 text-[12px]`}
                  onClick={() => void copyAddress()}
                >
                  {copied ? "Copied" : "Copy address"}
                </button>
                <button
                  type="button"
                  className={`${btnGhost} h-9 flex-1 text-[12px]`}
                  onClick={() => {
                    setOpen(false);
                    void disconnect();
                  }}
                >
                  Disconnect
                </button>
              </div>
            </>
          ) : wallets.length === 0 ? (
            <p className="text-faint text-[12px]">
              No supported wallet found in this browser. Install Phantom or Solflare, then reload
              this page.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {wallets.map((wallet) => (
                <li key={wallet.name}>
                  <button
                    type="button"
                    className={`${btnGhost} flex h-9 w-full items-center gap-2 px-3 text-[13px]`}
                    disabled={connecting}
                    onClick={() => void choose(wallet)}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- a wallet's own data: icon */}
                    <img src={wallet.icon} alt="" width={18} height={18} />
                    {wallet.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {problem && <p className="text-danger mt-2 text-[12px]">{problem}</p>}
        </div>
      )}
    </div>
  );
}

function BuiltInWalletWidget({ wallet }: { wallet: WalletHookResult }) {
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

  // A wallet held only in memory, funded or not, is gone after a reload:
  // the browser asks before leaving instead of losing it without a word.
  const heldAddress = wallet.account && !wallet.saved ? wallet.account.publicKey : null;
  useEffect(() => {
    if (!heldAddress) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (keptWalletAddress(browserLocalStorage()) !== heldAddress) event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [heldAddress]);

  // No wallet yet: the order panel is the one place that creates one (never
  // a second "Create test wallet" button here too).
  if (!wallet.ready) return <span className="text-faint text-[12px]">Loading wallet…</span>;
  const address = wallet.account?.publicKey ?? wallet.lockedAddress;
  if (!address) return null;

  function importSecret() {
    try {
      wallet.importSecret(importValue);
    } catch (error) {
      if (!(error instanceof WalletExistsError)) {
        setImportError("Wallet not imported. Check the secret and try again.");
        return;
      }
      const replace = window.confirm(
        "Replace the current wallet? Unless you saved its recovery details, it cannot be recovered. Its local order history on this device is removed too.",
      );
      if (!replace) return;
      try {
        wallet.importSecret(importValue, { replace: true });
      } catch {
        setImportError("Wallet not imported. Check the secret and try again.");
        return;
      }
    }
    setImportValue("");
    setOpen(false);
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        className="border-line text-ink rounded-tile min-h-11 border px-3 text-[13px]"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {formatShortAddress(address)}
        {!wallet.account && <span className="text-faint ml-2 text-[12px]">Locked</span>}
        {wallet.account && !wallet.saved && (
          <span className="text-danger ml-2 text-[12px]">Not saved</span>
        )}
      </button>
      {open && (
        <div className={`${panel} absolute right-0 z-10 mt-2 w-80 p-4`}>
          <p className="text-ink text-[13px] break-all">{address}</p>
          {!wallet.account ? (
            <div className="mt-3">
              <PassphraseForm
                id="wallet-unlock"
                label="Encrypted on this device. Enter its passphrase to trade."
                action="Unlock"
                busyAction="Unlocking…"
                onSubmit={async (passphrase) =>
                  (await wallet.unlock(passphrase)) ? null : "Wrong passphrase."
                }
              />
            </div>
          ) : (
            <>
              <p className="text-faint mt-1 text-[12px]">
                {wallet.saved
                  ? "Encrypted on this device."
                  : "Not saved on this device: reloading the page loses this wallet. Set a passphrase to keep it here, encrypted."}
              </p>
              {!wallet.saved && (
                <div className="mt-3">
                  <PassphraseForm
                    id="wallet-protect"
                    label="Passphrase for this device"
                    action="Encrypt and keep"
                    busyAction="Encrypting…"
                    isNew
                    onSubmit={async (passphrase) => {
                      try {
                        await wallet.protect(passphrase);
                        return null;
                      } catch {
                        return "The wallet could not be saved on this device.";
                      }
                    }}
                  />
                </div>
              )}
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
            </>
          )}
          <div className="border-line-subtle mt-4 border-t pt-3">
            <label className="text-faint text-[12px]" htmlFor="wallet-import">
              Import a saved secret
            </label>
            <input
              id="wallet-import"
              {...secretFieldProps}
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
              onClick={importSecret}
            >
              Import
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
